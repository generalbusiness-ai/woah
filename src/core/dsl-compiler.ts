import { hashSource } from "./source-hash";
import type { CompileDiagnostic, CompileResult, TinyBytecode, TinyOp, WooValue } from "./types";
import { valuesEqual, wooError } from "./types";

type Span = {
  index: number;
  end: number;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
};

type TokenKind = "identifier" | "number" | "string" | "objref" | "coreref" | "symbol" | "eof";

type Token = {
  kind: TokenKind;
  value: string;
  literal?: WooValue;
  span: Span;
};

type Program = {
  kind: "Program";
  name: string;
  params: string[];
  perms: string;
  argSpec: Record<string, WooValue>;
  body: BlockStmt;
  span: Span;
};

type Stmt =
  | BlockStmt
  | VarDeclStmt
  | AssignStmt
  | ExprStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | RaiseStmt
  | TryStmt;

type BlockStmt = { kind: "BlockStmt"; statements: Stmt[]; span: Span };
type VarDeclStmt = { kind: "VarDeclStmt"; name: string; value: Expr | null; span: Span };
type AssignStmt = { kind: "AssignStmt"; target: Expr; value: Expr; span: Span };
type ExprStmt = { kind: "ExprStmt"; expr: Expr; span: Span };
type IfStmt = { kind: "IfStmt"; test: Expr; consequent: BlockStmt; alternate: BlockStmt | IfStmt | null; span: Span };
type WhileStmt = { kind: "WhileStmt"; test: Expr; body: BlockStmt; span: Span };
type ForStmt = { kind: "ForStmt"; keyName: string; valueName: string | null; iterable: Expr; body: BlockStmt; span: Span };
type BreakStmt = { kind: "BreakStmt"; span: Span };
type ContinueStmt = { kind: "ContinueStmt"; span: Span };
type ReturnStmt = { kind: "ReturnStmt"; value: Expr | null; span: Span };
type RaiseStmt = { kind: "RaiseStmt"; value: Expr; span: Span };
type TryStmt = { kind: "TryStmt"; body: BlockStmt; errorName: string; errorCodes: string[]; handler: BlockStmt; span: Span };

type Expr =
  | LiteralExpr
  | IdentifierExpr
  | ListExpr
  | MapExpr
  | RangeExpr
  | UnaryExpr
  | BinaryExpr
  | LogicalExpr
  | PropertyExpr
  | DynamicPropertyExpr
  | IndexExpr
  | InterpExpr
  | CallExpr
  | VerbCallExpr;

type LiteralExpr = { kind: "LiteralExpr"; value: WooValue; span: Span };
type IdentifierExpr = { kind: "IdentifierExpr"; name: string; span: Span };
type ListExpr = { kind: "ListExpr"; items: Expr[]; span: Span };
type MapExpr = { kind: "MapExpr"; entries: { key: string; value: Expr }[]; span: Span };
type RangeExpr = { kind: "RangeExpr"; start: Expr; end: Expr; span: Span };
type UnaryExpr = { kind: "UnaryExpr"; op: "!" | "-"; expr: Expr; span: Span };
type BinaryExpr = { kind: "BinaryExpr"; op: string; left: Expr; right: Expr; span: Span };
type LogicalExpr = { kind: "LogicalExpr"; op: "&&" | "||"; left: Expr; right: Expr; span: Span };
type PropertyExpr = { kind: "PropertyExpr"; object: Expr; name: string; span: Span };
type DynamicPropertyExpr = { kind: "DynamicPropertyExpr"; object: Expr; name: Expr; span: Span };
type IndexExpr = { kind: "IndexExpr"; object: Expr; index: Expr; span: Span };
type InterpExpr = { kind: "InterpExpr"; parts: (string | Expr)[]; span: Span };
type CallExpr = { kind: "CallExpr"; callee: Expr; args: Expr[]; span: Span };
type VerbCallExpr = { kind: "VerbCallExpr"; object: Expr; name: string; args: Expr[]; span: Span };

class CompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly span?: Span
  ) {
    super(message);
  }
}

const KEYWORDS = new Set([
  "verb",
  "let",
  "const",
  "if",
  "else",
  "while",
  "for",
  "in",
  "break",
  "continue",
  "return",
  "try",
  "except",
  "finally",
  "raise",
  "true",
  "false",
  "null"
]);

const FRAME_GLOBALS = new Map<string, string>([
  ["this", "PUSH_THIS"],
  ["actor", "PUSH_ACTOR"],
  ["player", "PUSH_PLAYER"],
  ["caller", "PUSH_CALLER"],
  ["progr", "PUSH_PROGR"],
  ["space", "PUSH_SPACE"],
  ["seq", "PUSH_SEQ"],
  ["message", "PUSH_MESSAGE"],
  ["args", "PUSH_ARGS"],
  ["verb", "PUSH_VERB"]
]);

const BUILTINS = new Set([
  "length", "keys", "values", "has", "typeof", "to_string", "tostr", "to_int", "toint", "to_float", "tofloat", "min", "max", "floor", "ceil", "round", "abs",
  "str_trim", "str_lower", "str_starts", "str_index", "str_slice", "str_char", "str_join",
  "now", "create", "move", "moveto", "chparent", "has_flag", "isa", "random", "contents", "location", "task_perms", "caller_perms",
  "set_task_perms", "set_presence", "observe_to_space", "tell", "dispatch", "collect_prop",
  "current_location", "current_session", "session_location", "all_locations", "primary_session",
  "is_connected", "idle_seconds",
  "builder_create_object", "builder_chparent", "builder_recycle", "builder_set_property", "builder_inspect", "builder_search",
  "programmer_inspect", "programmer_resolve_verb", "programmer_list_verb", "programmer_search", "programmer_install_verb",
  "programmer_set_verb_info", "programmer_set_property_info", "programmer_trace",
  "editor_invoke", "editor_what", "editor_view", "editor_replace", "editor_insert", "editor_delete", "editor_dry_run", "editor_save", "editor_pause", "editor_abort"
]);
const RESERVED_NAMES = new Set([...FRAME_GLOBALS.keys(), ...KEYWORDS]);

export function compileWooSource(source: string): CompileResult {
  try {
    const tokens = new Lexer(source).scan();
    const program = new Parser(tokens).parseProgram();
    const compiled = new Codegen().compile(program);
    return {
      ok: true,
      diagnostics: [],
      bytecode: compiled.bytecode,
      source_hash: hashSource(source),
      line_map: compiled.lineMap,
      metadata: {
        name: program.name,
        perms: program.perms,
        arg_spec: program.argSpec
      }
    };
  } catch (err) {
    const diagnostic = compileDiagnostic(err);
    return { ok: false, diagnostics: [diagnostic] };
  }
}

function compileDiagnostic(err: unknown): CompileDiagnostic {
  if (err instanceof CompileError) {
    return {
      severity: "error",
      code: err.code,
      message: err.message,
      span: err.span ? toDiagnosticSpan(err.span) : undefined
    };
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const value = err as { code: string; message?: string };
    return { severity: "error", code: value.code, message: value.message ?? value.code };
  }
  return { severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err) };
}

function toDiagnosticSpan(span: Span): CompileDiagnostic["span"] {
  return {
    line: span.line,
    column: span.column,
    end_line: span.end_line,
    end_column: span.end_column
  };
}

class Lexer {
  private index = 0;
  private line = 1;
  private column = 0;
  private readonly tokens: Token[] = [];

  constructor(private readonly source: string) {}

  scan(): Token[] {
    while (!this.atEnd()) {
      this.skipTrivia();
      if (this.atEnd()) break;
      const ch = this.peek();
      if (isIdentStart(ch)) this.identifier();
      else if (isDigit(ch)) this.number();
      else if (ch === '"' || ch === "'") this.string();
      else if (ch === "$") this.ref("coreref");
      else if (ch === "#") this.ref("objref");
      else this.symbol();
    }
    const span = this.makeSpan(this.index, this.line, this.column, this.index, this.line, this.column);
    this.tokens.push({ kind: "eof", value: "<eof>", span });
    return this.tokens;
  }

  private skipTrivia(): void {
    let moved = true;
    while (moved && !this.atEnd()) {
      moved = false;
      while (!this.atEnd() && /\s/.test(this.peek())) {
        this.advance();
        moved = true;
      }
      if (this.peek() === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") this.advance();
        moved = true;
      } else if (this.peek() === "/" && this.peek(1) === "*") {
        this.advance();
        this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (this.atEnd()) throw this.error("unterminated block comment");
        this.advance();
        this.advance();
        moved = true;
      }
    }
  }

  private identifier(): void {
    const start = this.mark();
    let value = "";
    while (!this.atEnd() && isIdentPart(this.peek())) value += this.advance();
    this.push("identifier", value, start);
  }

  private number(): void {
    const start = this.mark();
    let value = "";
    while (!this.atEnd() && isDigit(this.peek())) value += this.advance();
    if (this.peek() === "." && this.peek(1) !== ".") {
      value += this.advance();
      while (!this.atEnd() && isDigit(this.peek())) value += this.advance();
    }
    this.push("number", value, start, Number(value));
  }

  private string(): void {
    const quote = this.peek();
    const start = this.mark();
    this.advance();
    let raw = "";
    while (!this.atEnd() && this.peek() !== quote) {
      const ch = this.advance();
      if (ch === "\\") {
        if (this.atEnd()) throw this.error("unterminated string literal", start);
        raw += "\\" + this.advance();
      } else {
        raw += ch;
      }
    }
    if (this.atEnd()) throw this.error("unterminated string literal", start);
    this.advance();
    const quoted = `"${raw.replace(/"/g, '\\"')}"`;
    try {
      this.push("string", JSON.parse(quoted), start, JSON.parse(quoted));
    } catch {
      throw this.error("invalid string escape", start);
    }
  }

  private ref(kind: "objref" | "coreref"): void {
    const start = this.mark();
    let value = this.advance();
    while (!this.atEnd() && /[A-Za-z0-9_.-]/.test(this.peek())) value += this.advance();
    if (value.length === 1) throw this.error(`invalid ${kind}`, start);
    this.push(kind, value, start, value);
  }

  private symbol(): void {
    const start = this.mark();
    const two = this.peek() + this.peek(1);
    if (["==", "!=", "<=", ">=", "&&", "||", ".."].includes(two)) {
      this.advance();
      this.advance();
      this.push("symbol", two, start);
      return;
    }
    const ch = this.advance();
    if (!"{}()[],:.;+-*/%!<>=.".includes(ch)) throw this.error(`unexpected character: ${ch}`, start);
    this.push("symbol", ch, start);
  }

  private push(kind: TokenKind, value: string, start: Mark, literal?: WooValue): void {
    const span = this.makeSpan(start.index, start.line, start.column, this.index, this.line, this.column);
    this.tokens.push({ kind, value, literal, span });
  }

  private mark(): Mark {
    return { index: this.index, line: this.line, column: this.column };
  }

  private makeSpan(index: number, line: number, column: number, end: number, endLine: number, endColumn: number): Span {
    return { index, line, column, end, end_line: endLine, end_column: endColumn };
  }

  private error(message: string, start?: Mark): CompileError {
    const from = start ?? this.mark();
    const span = this.makeSpan(from.index, from.line, from.column, this.index, this.line, this.column);
    return new CompileError("E_COMPILE", message, span);
  }

  private atEnd(): boolean {
    return this.index >= this.source.length;
  }

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? "\0";
  }

  private advance(): string {
    const ch = this.source[this.index++] ?? "\0";
    if (ch === "\n") {
      this.line += 1;
      this.column = 0;
    } else {
      this.column += 1;
    }
    return ch;
  }
}

type Mark = { index: number; line: number; column: number };

class Parser {
  private current = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const start = this.expectValue("verb", "expected verb declaration").span;
    if (!this.matchValue(":")) {
      this.parseVerbTarget();
      this.expectValue(":", "expected ':' before verb name");
    }
    const name = this.expectIdentifier("expected verb name").value;
    this.expectValue("(", "expected '(' after verb name");
    const { params, argSpec } = this.parseHeaderParams();
    this.expectValue(")", "expected ')' after verb parameters");
    const permsToken = this.expectIdentifier("expected verb permissions");
    if (!/^[rwxd]+$/.test(permsToken.value)) throw this.error("expected verb permissions as a subset of rwxd", permsToken);
    const perms = permsToken.value;
    const body = this.parseBlock();
    this.expectKind("eof", "expected end of source after verb body");
    return { kind: "Program", name, params, perms, argSpec, body, span: mergeSpan(start, body.span) };
  }

  parseStandaloneExpression(): Expr {
    const expr = this.parseExpression();
    this.expectKind("eof", "expected end of interpolated expression");
    return expr;
  }

  private parseVerbTarget(): void {
    if (["identifier", "objref", "coreref", "string"].includes(this.peek().kind)) {
      this.advance();
      return;
    }
    throw this.error("expected object target or ':' in verb declaration");
  }

  private parseHeaderParams(): { params: string[]; argSpec: Record<string, WooValue> } {
    const items: string[] = [];
    let sawComma = false;
    while (!this.checkValue(")") && !this.atEnd()) {
      const token = this.expectIdentifier("expected parameter name");
      items.push(token.value);
      if (this.matchValue(",")) sawComma = true;
    }
    if (!sawComma && items.length === 3) {
      return { params: [], argSpec: { dobj: items[0], prep: items[1], iobj: items[2] } };
    }
    return { params: items, argSpec: { params: items } };
  }

  private parseBlock(): BlockStmt {
    const start = this.expectValue("{", "expected '{'").span;
    const statements: Stmt[] = [];
    while (!this.checkValue("}") && !this.atEnd()) statements.push(this.parseStatement());
    const end = this.expectValue("}", "expected '}'").span;
    return { kind: "BlockStmt", statements, span: mergeSpan(start, end) };
  }

  private parseStatement(): Stmt {
    if (this.checkValue("{")) return this.parseBlock();
    if (this.matchValue("let") || this.matchValue("const")) return this.parseVarDecl(this.previous());
    if (this.matchValue("if")) return this.parseIf(this.previous());
    if (this.matchValue("while")) return this.parseWhile(this.previous());
    if (this.matchValue("for")) return this.parseFor(this.previous());
    if (this.matchValue("break")) {
      const token = this.previous();
      this.expectValue(";", "expected ';' after break");
      return { kind: "BreakStmt", span: token.span };
    }
    if (this.matchValue("continue")) {
      const token = this.previous();
      this.expectValue(";", "expected ';' after continue");
      return { kind: "ContinueStmt", span: token.span };
    }
    if (this.matchValue("return")) return this.parseReturn(this.previous());
    if (this.matchValue("raise")) return this.parseRaise(this.previous());
    if (this.matchValue("try")) return this.parseTry(this.previous());
    return this.parseExprOrAssignStmt();
  }

  private parseVarDecl(start: Token): VarDeclStmt {
    const name = this.expectIdentifier("expected local name").value;
    let value: Expr | null = null;
    if (this.matchValue("=")) value = this.parseExpression();
    this.expectValue(";", "expected ';' after local declaration");
    return { kind: "VarDeclStmt", name, value, span: mergeSpan(start.span, this.previous().span) };
  }

  private parseIf(start: Token): IfStmt {
    this.expectValue("(", "expected '(' after if");
    const test = this.parseExpression();
    this.expectValue(")", "expected ')' after if condition");
    const consequent = this.parseBlock();
    let alternate: BlockStmt | IfStmt | null = null;
    if (this.matchValue("else")) {
      if (this.matchValue("if")) alternate = this.parseIf(this.previous());
      else alternate = this.parseBlock();
    }
    return { kind: "IfStmt", test, consequent, alternate, span: mergeSpan(start.span, (alternate ?? consequent).span) };
  }

  private parseWhile(start: Token): WhileStmt {
    this.expectValue("(", "expected '(' after while");
    const test = this.parseExpression();
    this.expectValue(")", "expected ')' after while condition");
    const body = this.parseBlock();
    return { kind: "WhileStmt", test, body, span: mergeSpan(start.span, body.span) };
  }

  private parseFor(start: Token): ForStmt {
    const keyName = this.expectIdentifier("expected loop variable").value;
    let valueName: string | null = null;
    if (this.matchValue(",")) valueName = this.expectIdentifier("expected map value variable").value;
    this.expectValue("in", "expected 'in' in for loop");
    const iterable = this.parseExpression();
    const body = this.parseBlock();
    return { kind: "ForStmt", keyName, valueName, iterable, body, span: mergeSpan(start.span, body.span) };
  }

  private parseReturn(start: Token): ReturnStmt {
    if (this.matchValue(";")) return { kind: "ReturnStmt", value: null, span: start.span };
    const value = this.parseExpression();
    this.expectValue(";", "expected ';' after return value");
    return { kind: "ReturnStmt", value, span: mergeSpan(start.span, this.previous().span) };
  }

  private parseRaise(start: Token): RaiseStmt {
    const value = this.parseExpression();
    this.expectValue(";", "expected ';' after raised value");
    return { kind: "RaiseStmt", value, span: mergeSpan(start.span, this.previous().span) };
  }

  private parseTry(start: Token): TryStmt {
    const body = this.parseBlock();
    this.expectValue("except", "expected except handler after try block");
    const errorName = this.expectIdentifier("expected exception variable name").value;
    const errorCodes: string[] = [];
    if (this.matchValue("in")) {
      this.expectValue("(", "expected '(' before exception codes");
      if (!this.checkValue(")")) {
        do {
          const token = this.advance();
          if (token.kind === "identifier" || token.kind === "string") errorCodes.push(String(token.literal ?? token.value));
          else throw this.error("expected exception code", token);
        } while (this.matchValue(","));
      }
      this.expectValue(")", "expected ')' after exception codes");
    }
    const handler = this.parseBlock();
    if (this.matchValue("finally")) throw this.error("finally blocks are deferred from compiler M1", this.previous());
    return { kind: "TryStmt", body, errorName, errorCodes, handler, span: mergeSpan(start.span, handler.span) };
  }

  private parseExprOrAssignStmt(): Stmt {
    const expr = this.parseExpression();
    if (this.matchValue("=")) {
      const value = this.parseExpression();
      this.expectValue(";", "expected ';' after assignment");
      return { kind: "AssignStmt", target: expr, value, span: mergeSpan(expr.span, this.previous().span) };
    }
    this.expectValue(";", "expected ';' after expression");
    return { kind: "ExprStmt", expr, span: mergeSpan(expr.span, this.previous().span) };
  }

  private parseExpression(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let expr = this.parseAnd();
    while (this.matchValue("||")) {
      const op = this.previous();
      const right = this.parseAnd();
      expr = { kind: "LogicalExpr", op: "||", left: expr, right, span: mergeSpan(expr.span, right.span) };
      void op;
    }
    return expr;
  }

  private parseAnd(): Expr {
    let expr = this.parseComparison();
    while (this.matchValue("&&")) {
      const right = this.parseComparison();
      expr = { kind: "LogicalExpr", op: "&&", left: expr, right, span: mergeSpan(expr.span, right.span) };
    }
    return expr;
  }

  private parseComparison(): Expr {
    let expr = this.parseTerm();
    while (this.matchValue("==") || this.matchValue("!=") || this.matchValue("<") || this.matchValue("<=") || this.matchValue(">") || this.matchValue(">=") || this.matchValue("in")) {
      const op = this.previous().value;
      const right = this.parseTerm();
      expr = { kind: "BinaryExpr", op, left: expr, right, span: mergeSpan(expr.span, right.span) };
    }
    return expr;
  }

  private parseTerm(): Expr {
    let expr = this.parseFactor();
    while (this.matchValue("+") || this.matchValue("-")) {
      const op = this.previous().value;
      const right = this.parseFactor();
      expr = { kind: "BinaryExpr", op, left: expr, right, span: mergeSpan(expr.span, right.span) };
    }
    return expr;
  }

  private parseFactor(): Expr {
    let expr = this.parseUnary();
    while (this.matchValue("*") || this.matchValue("/") || this.matchValue("%")) {
      const op = this.previous().value;
      const right = this.parseUnary();
      expr = { kind: "BinaryExpr", op, left: expr, right, span: mergeSpan(expr.span, right.span) };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.matchValue("!") || this.matchValue("-")) {
      const op = this.previous();
      const expr = this.parseUnary();
      return { kind: "UnaryExpr", op: op.value as "!" | "-", expr, span: mergeSpan(op.span, expr.span) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.matchValue(".")) {
        if (this.matchValue("(")) {
          const name = this.parseExpression();
          const end = this.expectValue(")", "expected ')' after dynamic property name");
          expr = { kind: "DynamicPropertyExpr", object: expr, name, span: mergeSpan(expr.span, end.span) };
        } else {
          const name = this.expectIdentifier("expected property name after '.'").value;
          expr = { kind: "PropertyExpr", object: expr, name, span: mergeSpan(expr.span, this.previous().span) };
        }
      } else if (this.matchValue(":")) {
        const name = this.expectIdentifier("expected verb name after ':'").value;
        this.expectValue("(", "expected '(' after verb name");
        const args = this.parseArgumentList();
        const end = this.expectValue(")", "expected ')' after verb arguments");
        expr = { kind: "VerbCallExpr", object: expr, name, args, span: mergeSpan(expr.span, end.span) };
      } else if (this.matchValue("(")) {
        const args = this.parseArgumentList();
        const end = this.expectValue(")", "expected ')' after call arguments");
        expr = { kind: "CallExpr", callee: expr, args, span: mergeSpan(expr.span, end.span) };
      } else if (this.matchValue("[")) {
        const index = this.parseExpression();
        const end = this.expectValue("]", "expected ']' after index");
        expr = { kind: "IndexExpr", object: expr, index, span: mergeSpan(expr.span, end.span) };
      } else {
        return expr;
      }
    }
  }

  private parseArgumentList(): Expr[] {
    const args: Expr[] = [];
    if (this.checkValue(")")) return args;
    do {
      args.push(this.parseExpression());
    } while (this.matchValue(","));
    return args;
  }

  private parsePrimary(): Expr {
    if (this.matchValue("true")) return literalExpr(true, this.previous().span);
    if (this.matchValue("false")) return literalExpr(false, this.previous().span);
    if (this.matchValue("null")) return literalExpr(null, this.previous().span);
    if (this.peek().kind === "number") {
      const token = this.advance();
      return literalExpr(token.literal ?? Number(token.value), token.span);
    }
    if (this.peek().kind === "string") {
      const token = this.advance();
      const value = String(token.literal ?? token.value);
      if (value.includes("${")) return parseInterpolatedString(value, token.span);
      return literalExpr(value, token.span);
    }
    if (this.peek().kind === "objref" || this.peek().kind === "coreref") {
      const token = this.advance();
      return literalExpr(token.literal ?? token.value, token.span);
    }
    if (this.peek().kind === "identifier") {
      const token = this.advance();
      return { kind: "IdentifierExpr", name: token.value, span: token.span };
    }
    if (this.matchValue("(")) {
      const expr = this.parseExpression();
      this.expectValue(")", "expected ')' after expression");
      return expr;
    }
    if (this.matchValue("[")) return this.parseListOrRange(this.previous());
    if (this.matchValue("{")) return this.parseMap(this.previous());
    throw this.error("expected expression");
  }

  private parseListOrRange(start: Token): Expr {
    if (this.matchValue("]")) return { kind: "ListExpr", items: [], span: mergeSpan(start.span, this.previous().span) };
    const first = this.parseExpression();
    if (this.matchValue("..")) {
      const endExpr = this.parseExpression();
      const end = this.expectValue("]", "expected ']' after range");
      return { kind: "RangeExpr", start: first, end: endExpr, span: mergeSpan(start.span, end.span) };
    }
    const items = [first];
    while (this.matchValue(",")) {
      if (this.checkValue("]")) break;
      items.push(this.parseExpression());
    }
    const end = this.expectValue("]", "expected ']' after list literal");
    return { kind: "ListExpr", items, span: mergeSpan(start.span, end.span) };
  }

  private parseMap(start: Token): Expr {
    const entries: { key: string; value: Expr }[] = [];
    if (!this.checkValue("}")) {
      do {
        const keyToken = this.advance();
        if (keyToken.kind !== "string" && keyToken.kind !== "identifier") throw this.error("expected map key", keyToken);
        const key = String(keyToken.literal ?? keyToken.value);
        this.expectValue(":", "expected ':' after map key");
        entries.push({ key, value: this.parseExpression() });
      } while (this.matchValue(","));
    }
    const end = this.expectValue("}", "expected '}' after map literal");
    return { kind: "MapExpr", entries, span: mergeSpan(start.span, end.span) };
  }

  private matchValue(value: string): boolean {
    if (!this.checkValue(value)) return false;
    this.advance();
    return true;
  }

  private checkValue(value: string): boolean {
    return this.peek().value === value;
  }

  private expectValue(value: string, message: string): Token {
    if (this.checkValue(value)) return this.advance();
    throw this.error(message);
  }

  private expectIdentifier(message: string): Token {
    if (this.peek().kind === "identifier") return this.advance();
    throw this.error(message);
  }

  private expectKind(kind: TokenKind, message: string): Token {
    if (this.peek().kind === kind) return this.advance();
    throw this.error(message);
  }

  private atEnd(): boolean {
    return this.peek().kind === "eof";
  }

  private peek(): Token {
    return this.tokens[this.current] ?? this.tokens[this.tokens.length - 1];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private advance(): Token {
    if (!this.atEnd()) this.current += 1;
    return this.previous();
  }

  private error(message: string, token = this.peek()): CompileError {
    return new CompileError("E_COMPILE", message, token.span);
  }
}

class Codegen {
  private readonly ops: TinyOp[] = [];
  private readonly literals: WooValue[] = [];
  private readonly lineMap: Record<string, WooValue> = {};
  private readonly locals = new Map<string, number>();
  private readonly loops: { breaks: number[]; continues: number[]; continueTarget: number }[] = [];
  private activeSpan: Span | null = null;
  private localCount = 0;

  compile(program: Program): { bytecode: TinyBytecode; lineMap: Record<string, WooValue> } {
    for (const param of program.params) this.declareLocal(param, program.span);
    this.compileBlock(program.body);
    this.withSpan(program.body.span, () => {
      this.emit("PUSH_LIT", this.literal(null));
      this.emit("RETURN");
    });
    return {
      bytecode: {
        ops: this.ops,
        literals: this.literals,
        num_locals: this.localCount,
        max_stack: 128,
        version: 1
      },
      lineMap: this.lineMap
    };
  }

  private compileBlock(block: BlockStmt): void {
    for (const statement of block.statements) this.compileStmt(statement);
  }

  private compileStmt(statement: Stmt): void {
    this.withSpan(statement.span, () => {
      switch (statement.kind) {
        case "BlockStmt":
          this.compileBlock(statement);
          break;
        case "VarDeclStmt":
          this.compileVarDecl(statement);
          break;
        case "AssignStmt":
          this.compileAssign(statement);
          break;
        case "ExprStmt":
          if (this.compileSpecialCallStatement(statement.expr)) break;
          this.compileExpr(statement.expr);
          this.emit("POP");
          break;
        case "IfStmt":
          this.compileIf(statement);
          break;
        case "WhileStmt":
          this.compileWhile(statement);
          break;
        case "ForStmt":
          this.compileFor(statement);
          break;
        case "BreakStmt":
          this.compileBreak(statement);
          break;
        case "ContinueStmt":
          this.compileContinue(statement);
          break;
        case "ReturnStmt":
          if (statement.value) this.compileExpr(statement.value);
          else this.emit("PUSH_LIT", this.literal(null));
          this.emit("RETURN");
          break;
        case "RaiseStmt":
          this.compileExpr(statement.value);
          this.emit("RAISE");
          break;
        case "TryStmt":
          this.compileTry(statement);
          break;
      }
    });
  }

  private compileVarDecl(statement: VarDeclStmt): void {
    const local = this.declareLocal(statement.name, statement.span);
    if (statement.value) this.compileExpr(statement.value);
    else this.emit("PUSH_LIT", this.literal(null));
    this.emit("POP_LOCAL", local);
  }

  private compileAssign(statement: AssignStmt): void {
    const target = statement.target;
    if (target.kind === "IdentifierExpr") {
      const local = this.requireLocal(target.name, target.span);
      this.compileExpr(statement.value);
      this.emit("POP_LOCAL", local);
      return;
    }
    if (target.kind === "PropertyExpr") {
      this.compileExpr(target.object);
      this.emit("PUSH_LIT", this.literal(target.name));
      this.compileExpr(statement.value);
      this.emit("SET_PROP");
      return;
    }
    if (target.kind === "DynamicPropertyExpr") {
      this.compileExpr(target.object);
      this.compileExpr(target.name);
      this.compileExpr(statement.value);
      this.emit("SET_PROP");
      return;
    }
    if (target.kind === "IndexExpr" && target.object.kind === "IdentifierExpr") {
      const local = this.requireLocal(target.object.name, target.object.span);
      this.emit("PUSH_LOCAL", local);
      this.compileExpr(target.index);
      this.compileExpr(statement.value);
      this.emit("INDEX_SET");
      this.emit("POP_LOCAL", local);
      return;
    }
    throw new CompileError("E_COMPILE", "unsupported assignment target", statement.span);
  }

  private compileIf(statement: IfStmt): void {
    this.compileExpr(statement.test);
    const elseJump = this.emitJump("JUMP_IF_FALSE");
    this.compileBlock(statement.consequent);
    if (!statement.alternate) {
      this.patchJump(elseJump, this.ops.length);
      return;
    }
    const endJump = this.emitJump("JUMP");
    this.patchJump(elseJump, this.ops.length);
    if (statement.alternate.kind === "IfStmt") this.compileIf(statement.alternate);
    else this.compileBlock(statement.alternate);
    this.patchJump(endJump, this.ops.length);
  }

  private compileWhile(statement: WhileStmt): void {
    const start = this.ops.length;
    this.compileExpr(statement.test);
    const exitJump = this.emitJump("JUMP_IF_FALSE");
    const loop = { breaks: [], continues: [], continueTarget: start };
    this.loops.push(loop);
    this.compileBlock(statement.body);
    this.loops.pop();
    this.emitRelativeJump(start);
    const end = this.ops.length;
    this.patchJump(exitJump, end);
    for (const item of loop.breaks) this.patchJump(item, end);
    for (const item of loop.continues) this.patchJump(item, start);
  }

  private compileFor(statement: ForStmt): void {
    if (statement.iterable.kind === "RangeExpr") {
      const local = this.ensureLoopLocal(statement.keyName, statement.span);
      this.compileExpr(statement.iterable.end);
      this.compileExpr(statement.iterable.start);
      this.emit("FOR_RANGE_INIT", local);
      const next = this.ops.length;
      const exit = this.emit("FOR_RANGE_NEXT", local, 0);
      this.compileLoopBody(statement.body, next, exit, "range");
      return;
    }
    if (statement.valueName) {
      const keyLocal = this.ensureLoopLocal(statement.keyName, statement.span);
      const valueLocal = this.ensureLoopLocal(statement.valueName, statement.span);
      this.compileExpr(statement.iterable);
      this.emit("FOR_MAP_INIT");
      const next = this.ops.length;
      const exit = this.emit("FOR_MAP_NEXT", keyLocal, valueLocal, 0);
      this.compileLoopBody(statement.body, next, exit, "map");
      return;
    }
    const local = this.ensureLoopLocal(statement.keyName, statement.span);
    this.compileExpr(statement.iterable);
    this.emit("FOR_LIST_INIT", local);
    const next = this.ops.length;
    const exit = this.emit("FOR_LIST_NEXT", local, 0);
    this.compileLoopBody(statement.body, next, exit, "list");
  }

  private compileLoopBody(body: BlockStmt, next: number, exit: number, kind: "list" | "range" | "map"): void {
    const loop = { breaks: [], continues: [], continueTarget: next };
    this.loops.push(loop);
    this.compileBlock(body);
    this.loops.pop();
    this.emitRelativeJump(next);
    const forEnd = this.ops.length;
    if (kind === "map") this.ops[exit][3] = forEnd - exit - 1;
    else this.ops[exit][2] = forEnd - exit - 1;
    for (const item of loop.breaks) this.patchJump(item, forEnd);
    for (const item of loop.continues) this.patchJump(item, next);
    this.emit("FOR_END");
  }

  private compileBreak(statement: BreakStmt): void {
    const loop = this.loops[this.loops.length - 1];
    if (!loop) throw new CompileError("E_COMPILE", "break outside loop", statement.span);
    loop.breaks.push(this.emitJump("JUMP"));
  }

  private compileContinue(statement: ContinueStmt): void {
    const loop = this.loops[this.loops.length - 1];
    if (!loop) throw new CompileError("E_COMPILE", "continue outside loop", statement.span);
    loop.continues.push(this.emitJump("JUMP"));
  }

  private compileTry(statement: TryStmt): void {
    const errorsLiteral = this.literal(statement.errorCodes);
    const tryPush = this.emit("TRY_PUSH", 0, errorsLiteral);
    this.compileBlock(statement.body);
    this.emit("TRY_POP");
    const endJump = this.emitJump("JUMP");
    const handlerStart = this.ops.length;
    this.ops[tryPush][1] = handlerStart - tryPush - 1;
    const errorLocal = this.ensureLoopLocal(statement.errorName, statement.span);
    this.emit("POP_LOCAL", errorLocal);
    this.compileBlock(statement.handler);
    this.patchJump(endJump, this.ops.length);
  }

  private compileSpecialCallStatement(expr: Expr): boolean {
    if (expr.kind !== "CallExpr" || expr.callee.kind !== "IdentifierExpr") return false;
    const name = expr.callee.name;
    if (name === "observe") {
      if (expr.args.length !== 1) throw new CompileError("E_COMPILE", "observe expects one argument", expr.span);
      this.compileExpr(expr.args[0]);
      this.emit("OBSERVE");
      return true;
    }
    if (name === "emit") {
      if (expr.args.length !== 2) throw new CompileError("E_COMPILE", "emit expects target and event arguments", expr.span);
      this.compileExpr(expr.args[0]);
      this.compileExpr(expr.args[1]);
      this.emit("EMIT");
      return true;
    }
    return false;
  }

  private compileExpr(expr: Expr): void {
    this.withSpan(expr.span, () => {
      switch (expr.kind) {
        case "LiteralExpr":
          this.emit("PUSH_LIT", this.literal(expr.value));
          break;
        case "IdentifierExpr":
          this.compileIdentifier(expr);
          break;
        case "ListExpr":
          for (const item of expr.items) this.compileExpr(item);
          this.emit("MAKE_LIST", expr.items.length);
          break;
        case "MapExpr":
          for (const entry of expr.entries) {
            this.emit("PUSH_LIT", this.literal(entry.key));
            this.compileExpr(entry.value);
          }
          this.emit("MAKE_MAP", expr.entries.length);
          break;
        case "RangeExpr":
          throw new CompileError("E_COMPILE", "range expressions are only supported in for loops", expr.span);
        case "UnaryExpr":
          this.compileExpr(expr.expr);
          this.emit(expr.op === "!" ? "NOT" : "NEG");
          break;
        case "BinaryExpr":
          this.compileBinary(expr);
          break;
        case "LogicalExpr":
          this.compileLogical(expr);
          break;
        case "PropertyExpr":
          this.compileExpr(expr.object);
          this.emit("PUSH_LIT", this.literal(expr.name));
          this.emit("GET_PROP");
          break;
        case "DynamicPropertyExpr":
          this.compileExpr(expr.object);
          this.compileExpr(expr.name);
          this.emit("GET_PROP");
          break;
        case "IndexExpr":
          this.compileExpr(expr.object);
          this.compileExpr(expr.index);
          this.emit("INDEX_GET");
          break;
        case "InterpExpr":
          this.compileInterpolation(expr);
          break;
        case "CallExpr":
          this.compileCall(expr);
          break;
        case "VerbCallExpr":
          this.compileExpr(expr.object);
          this.emit("PUSH_LIT", this.literal(expr.name));
          for (const arg of expr.args) this.compileExpr(arg);
          this.emit("CALL_VERB", expr.args.length);
          break;
      }
    });
  }

  private compileIdentifier(expr: IdentifierExpr): void {
    const local = this.locals.get(expr.name);
    if (local !== undefined) {
      this.emit("PUSH_LOCAL", local);
      return;
    }
    const globalOp = FRAME_GLOBALS.get(expr.name);
    if (globalOp) {
      this.emit(globalOp);
      return;
    }
    throw new CompileError("E_COMPILE", `unknown identifier: ${expr.name}`, expr.span);
  }

  private compileBinary(expr: BinaryExpr): void {
    this.compileExpr(expr.left);
    this.compileExpr(expr.right);
    const op = {
      "+": "ADD",
      "-": "SUB",
      "*": "MUL",
      "/": "DIV",
      "%": "MOD",
      "==": "EQ",
      "!=": "NEQ",
      "<": "LT",
      "<=": "LE",
      ">": "GT",
      ">=": "GE",
      in: "IN"
    }[expr.op];
    if (!op) throw new CompileError("E_COMPILE", `unsupported operator: ${expr.op}`, expr.span);
    this.emit(op);
  }

  private compileLogical(expr: LogicalExpr): void {
    this.compileExpr(expr.left);
    const jump = this.emitJump(expr.op === "&&" ? "JUMP_IF_FALSE_KEEP" : "JUMP_IF_TRUE_KEEP");
    this.emit("POP");
    this.compileExpr(expr.right);
    this.patchJump(jump, this.ops.length);
  }

  private compileCall(expr: CallExpr): void {
    if (expr.callee.kind !== "IdentifierExpr") throw new CompileError("E_COMPILE", "only builtin calls are supported without ':'", expr.span);
    const name = expr.callee.name;
    if (name === "pass") {
      for (const arg of expr.args) this.compileExpr(arg);
      this.emit("PASS", expr.args.length);
      return;
    }
    if (name === "observe") {
      if (expr.args.length !== 1) throw new CompileError("E_COMPILE", "observe expects one argument", expr.span);
      this.compileExpr(expr.args[0]);
      this.emit("OBSERVE");
      this.emit("PUSH_LIT", this.literal(null));
      return;
    }
    if (name === "emit") {
      if (expr.args.length !== 2) throw new CompileError("E_COMPILE", "emit expects target and event arguments", expr.span);
      this.compileExpr(expr.args[0]);
      this.compileExpr(expr.args[1]);
      this.emit("EMIT");
      this.emit("PUSH_LIT", this.literal(null));
      return;
    }
    if (name === "suspend") {
      if (expr.args.length !== 1) throw new CompileError("E_COMPILE", "suspend expects seconds", expr.span);
      this.compileExpr(expr.args[0]);
      this.emit("SUSPEND");
      return;
    }
    if (name === "read") {
      if (expr.args.length !== 1) throw new CompileError("E_COMPILE", "read expects player", expr.span);
      this.compileExpr(expr.args[0]);
      this.emit("READ");
      return;
    }
    if (name === "fork") {
      if (expr.args.length < 3) throw new CompileError("E_COMPILE", "fork expects delay, target, verb, and optional args", expr.span);
      this.compileExpr(expr.args[0]);
      this.compileExpr(expr.args[1]);
      this.compileExpr(expr.args[2]);
      for (const arg of expr.args.slice(3)) this.compileExpr(arg);
      this.emit("FORK", expr.args.length - 3);
      return;
    }
    if (!BUILTINS.has(name)) throw new CompileError("E_COMPILE", `unknown builtin: ${name}`, expr.span);
    for (const arg of expr.args) this.compileExpr(arg);
    let canonical = name;
    if (name === "tostr") canonical = "to_string";
    else if (name === "toint") canonical = "to_int";
    else if (name === "tofloat") canonical = "to_float";
    this.emit("BUILTIN", canonical, expr.args.length);
  }

  private compileInterpolation(expr: InterpExpr): void {
    for (const part of expr.parts) {
      if (typeof part === "string") {
        this.emit("PUSH_LIT", this.literal(part));
      } else {
        this.compileExpr(part);
        this.emit("BUILTIN", "to_string", 1);
      }
    }
    this.emit("STR_INTERP", expr.parts.length);
  }

  private declareLocal(name: string, span: Span): number {
    if (RESERVED_NAMES.has(name)) throw new CompileError("E_COMPILE", `reserved local name: ${name}`, span);
    if (this.locals.has(name)) throw new CompileError("E_COMPILE", `duplicate local: ${name}`, span);
    const local = this.localCount++;
    this.locals.set(name, local);
    return local;
  }

  private ensureLoopLocal(name: string, span: Span): number {
    const existing = this.locals.get(name);
    if (existing !== undefined) return existing;
    return this.declareLocal(name, span);
  }

  private requireLocal(name: string, span: Span): number {
    const local = this.locals.get(name);
    if (local === undefined) throw new CompileError("E_COMPILE", `unknown local: ${name}`, span);
    return local;
  }

  private literal(value: WooValue): number {
    const existing = this.literals.findIndex((item) => valuesEqual(item, value));
    if (existing >= 0) return existing;
    this.literals.push(value);
    return this.literals.length - 1;
  }

  private emit(op: string, ...operands: WooValue[]): number {
    this.ops.push([op, ...operands]);
    const index = this.ops.length - 1;
    if (this.activeSpan) {
      this.lineMap[String(index)] = {
        line: this.activeSpan.line,
        column: this.activeSpan.column,
        end_line: this.activeSpan.end_line,
        end_column: this.activeSpan.end_column
      };
    }
    return index;
  }

  private emitJump(op: string): number {
    return this.emit(op, 0);
  }

  private emitRelativeJump(target: number): void {
    const index = this.emit("JUMP", 0);
    this.patchJump(index, target);
  }

  private patchJump(index: number, target: number): void {
    this.ops[index][1] = target - index - 1;
  }

  private withSpan<T>(span: Span, fn: () => T): T {
    const previous = this.activeSpan;
    this.activeSpan = span;
    try {
      return fn();
    } finally {
      this.activeSpan = previous;
    }
  }
}

function literalExpr(value: WooValue, span: Span): LiteralExpr {
  return { kind: "LiteralExpr", value, span };
}

function parseInterpolatedString(value: string, span: Span): InterpExpr {
  const parts: (string | Expr)[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("${", cursor);
    if (start < 0) {
      if (cursor < value.length) parts.push(value.slice(cursor));
      break;
    }
    if (start > cursor) parts.push(value.slice(cursor, start));
    const end = value.indexOf("}", start + 2);
    if (end < 0) throw new CompileError("E_COMPILE", "unterminated string interpolation", span);
    const expressionSource = value.slice(start + 2, end).trim();
    if (!expressionSource) throw new CompileError("E_COMPILE", "empty string interpolation", span);
    parts.push(new Parser(new Lexer(expressionSource).scan()).parseStandaloneExpression());
    cursor = end + 1;
  }
  return { kind: "InterpExpr", parts, span };
}

function mergeSpan(start: Span, end: Span): Span {
  return {
    index: start.index,
    line: start.line,
    column: start.column,
    end: end.end,
    end_line: end.end_line,
    end_column: end.end_column
  };
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return /[0-9]/.test(ch);
}
