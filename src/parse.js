import {getLineInfo, tokTypes as tt, Parser} from "acorn";
import defaultGlobals from "./globals.js";
import findReferences from "./references.js";

const SCOPE_FUNCTION = 2;
const SCOPE_ASYNC = 4;
const SCOPE_GENERATOR = 8;

const STATE_START = Symbol("start");
const STATE_MODIFIER = Symbol("modifier");
const STATE_FUNCTION = Symbol("function");
const STATE_NAME = Symbol("name");

export function parseCell(input, {globals} = {}) {
  return parseReferences(CellParser.parse(input), input, globals);
}

/*
                       ┌─────┐
           ┌───────────│START│─function|class
           │           └─────┘             │
viewof|mutable|async      │                ▼
           │              │           ┌────────┐     ┌─┐
           ▼              │           │FUNCTION│◀───▶│*│
      ┌────────┐          │           └────────┘     └─┘
      │MODIFIER│          │                │
      └────────┘        name             name
           │              │                │
           └──name─┐      │                ▼
                   ▼      │         ┌─────────────┐
              ┌────────┐  │         │FUNCTION_NAME│
              │  NAME  │◀─┘         └─────────────┘
              └────────┘
                   │
                   =
                   ▼
              ┌────────┐
              │   EQ   │
              └────────┘
*/

export function peekId(input) {
  let state = STATE_START;
  let name;
  try {
    for (const token of Parser.tokenizer(input, {ecmaVersion: 11})) {
      switch (state) {
        case STATE_START:
        case STATE_MODIFIER: {
          if (token.type === tt.name) {
            if (
              state === STATE_START &&
              (token.value === "viewof" ||
                token.value === "mutable" ||
                token.value === "async")
            ) {
              state = STATE_MODIFIER;
              continue;
            }
            state = STATE_NAME;
            name = token;
            continue;
          }
          if (token.type === tt._function || token.type === tt._class) {
            state = STATE_FUNCTION;
            continue;
          }
          break;
        }
        case STATE_NAME: {
          if (token.type === tt.eq) return name.value;
          break;
        }
        case STATE_FUNCTION: {
          if (token.type === tt.star) continue;
          if (token.type === tt.name && token.end < input.length)
            return token.value;
          break;
        }
      }
      return;
    }
  } catch (ignore) {
    return;
  }
}

const fileAttachmentMessage =
  "FileAttachment() requires a single literal string as its argument.";
const fileAttachmentMessageReassign = "FileAttachment() cannot be reassigned.";

export class CellParser extends Parser {
  constructor(options, ...args) {
    super(Object.assign({ecmaVersion: 11}, options), ...args);
  }
  enterScope(flags) {
    if (flags & SCOPE_FUNCTION) ++this.O_function;
    return super.enterScope(flags);
  }
  exitScope() {
    if (this.currentScope().flags & SCOPE_FUNCTION) --this.O_function;
    return super.exitScope();
  }
  parseFileAttachment() {
    if (!this.isContextual("FileAttachment")) return;

    const node = this.startNode();
    node.callee = this.parseIdent();

    if (!this.eat(tt.parenL)) {
      this.raise(this.start, fileAttachmentMessageReassign);
    }

    if (this.type !== tt.string && this.type !== tt.backQuote) {
      this.unexpected(null, fileAttachmentMessage);
    }

    const source = this.parseExprAtom();
    if (source.type === "TemplateLiteral" && source.expressions.length) {
      this.unexpected(source.expressions[0].start, fileAttachmentMessage);
    }

    if (!this.eat(tt.parenR)) {
      this.raise(this.start, fileAttachmentMessage);
    }

    const fileReference =
      source.type === "Literal" ? source.value : source.quasis[0].value.cooked;
    const fileLocation = {start: source.start, end: source.end};

    if (this.fileAttachments.has(fileReference)) {
      this.fileAttachments.get(fileReference).push(fileLocation);
    } else {
      this.fileAttachments.set(fileReference, [fileLocation]);
    }

    node.arguments = [source];

    return this.finishNode(node, "CallExpression");
  }
  parseForIn(node, init) {
    if (this.O_function === 1 && node.await) this.O_async = true;
    return super.parseForIn(node, init);
  }
  parseAwait() {
    if (this.O_function === 1) this.O_async = true;
    return super.parseAwait();
  }
  parseYield(noIn) {
    if (this.O_function === 1) this.O_generator = true;
    return super.parseYield(noIn);
  }
  parseImport(node) {
    this.next();
    node.specifiers = this.parseImportSpecifiers();
    if (this.type === tt._with) {
      this.next();
      node.injections = this.parseImportSpecifiers();
    }
    this.expectContextual("from");
    node.source =
      this.type === tt.string ? this.parseExprAtom() : this.unexpected();
    return this.finishNode(node, "ImportDeclaration");
  }
  parseImportSpecifiers() {
    const nodes = [];
    let first = true;
    this.expect(tt.braceL);
    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma);
        if (this.afterTrailingComma(tt.braceR)) break;
      }
      const node = this.startNode();
      node.view = this.eatContextual("viewof");
      if (!node.view) node.mutable = this.eatContextual("mutable");
      node.imported = this.parseIdent();
      if (this.eatContextual("as")) {
        node.local = this.parseIdent();
      } else {
        this.checkUnreserved(node.imported);
        node.local = node.imported;
      }
      this.checkLVal(node.local, "let");
      nodes.push(this.finishNode(node, "ImportSpecifier"));
    }
    return nodes;
  }
  parseExprAtom(refDestructuringErrors) {
    return (
      this.parseMaybeKeywordExpression("viewof", "ViewExpression") ||
      this.parseMaybeKeywordExpression("mutable", "MutableExpression") ||
      this.parseFileAttachment() ||
      super.parseExprAtom(refDestructuringErrors)
    );
  }
  parseCell(node, eof) {
    const lookahead = new CellParser({}, this.input, this.start);
    let token = lookahead.getToken();
    let body = null;
    let id = null;

    this.fileAttachments = new Map();
    this.O_function = 0;
    this.O_async = false;
    this.O_generator = false;
    this.strict = true;
    this.enterScope(SCOPE_FUNCTION | SCOPE_ASYNC | SCOPE_GENERATOR);

    // An import?
    if (token.type === tt._import && lookahead.getToken().type !== tt.parenL) {
      body = this.parseImport(this.startNode());
    }

    // A non-empty cell?
    else if (token.type !== tt.eof && token.type !== tt.semi) {
      // A named cell?
      if (token.type === tt.name) {
        if (token.value === "viewof" || token.value === "mutable") {
          token = lookahead.getToken();
          if (token.type !== tt.name) {
            lookahead.unexpected();
          }
        }
        token = lookahead.getToken();
        if (token.type === tt.eq) {
          id =
            this.parseMaybeKeywordExpression("viewof", "ViewExpression") ||
            this.parseMaybeKeywordExpression("mutable", "MutableExpression") ||
            this.parseIdent();
          token = lookahead.getToken();
          this.expect(tt.eq);
        }
      }

      // A block?
      if (token.type === tt.braceL) {
        body = this.parseBlock();
      }

      // An expression?
      // Possibly a function or class declaration?
      else {
        body = this.parseExpression();
        if (
          id === null &&
          (body.type === "FunctionExpression" ||
            body.type === "ClassExpression")
        ) {
          id = body.id;
        }
      }
    }

    this.semicolon();
    if (eof) this.expect(tt.eof); // TODO

    node.id = id;
    node.async = this.O_async;
    node.generator = this.O_generator;
    node.body = body;
    node.fileAttachments = this.fileAttachments;
    this.exitScope();
    return this.finishNode(node, "Cell");
  }
  parseTopLevel(node) {
    return this.parseCell(node, true);
  }
  toAssignable(node, isBinding, refDestructuringErrors) {
    return node.type === "MutableExpression"
      ? node
      : super.toAssignable(node, isBinding, refDestructuringErrors);
  }
  checkUnreserved(node) {
    if (node.name === "viewof" || node.name === "mutable") {
      this.raise(node.start, `Unexpected keyword '${node.name}'`);
    }
    return super.checkUnreserved(node);
  }
  checkLVal(expr, bindingType, checkClashes) {
    return super.checkLVal(
      expr.type === "MutableExpression" ? expr.id : expr,
      bindingType,
      checkClashes
    );
  }
  unexpected(pos, message) {
    this.raise(
      pos != null ? pos : this.start,
      message
        ? message
        : this.type === tt.eof
        ? "Unexpected end of input"
        : "Unexpected token"
    );
  }
  parseMaybeKeywordExpression(keyword, type) {
    if (this.isContextual(keyword)) {
      const node = this.startNode();
      this.next();
      node.id = this.parseIdent();
      return this.finishNode(node, type);
    }
  }
}

export function parseModule(input, {globals} = {}) {
  const program = ModuleParser.parse(input);
  for (const cell of program.cells) {
    parseReferences(cell, input, globals);
  }
  return program;
}

export class ModuleParser extends CellParser {
  parseTopLevel(node) {
    if (!node.cells) node.cells = [];
    while (this.type !== tt.eof) {
      const cell = this.parseCell(this.startNode());
      cell.input = this.input;
      node.cells.push(cell);
    }
    this.next();
    return this.finishNode(node, "Program");
  }
}

// Find references.
// Check for illegal references to arguments.
// Check for illegal assignments to global references.
function parseReferences(cell, input, globals = defaultGlobals) {
  if (cell.body && cell.body.type !== "ImportDeclaration") {
    try {
      cell.references = findReferences(cell, globals);
    } catch (error) {
      if (error.node) {
        const loc = getLineInfo(input, error.node.start);
        error.message += ` (${loc.line}:${loc.column})`;
        error.pos = error.node.start;
        error.loc = loc;
        delete error.node;
      }
      throw error;
    }
  }
  return cell;
}
