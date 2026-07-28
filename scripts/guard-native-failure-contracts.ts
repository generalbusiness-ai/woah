import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  nativePrimitiveContractDisciplineErrors,
  type BuiltinNativeHandlerMutationKind
} from "../src/core/native-primitive-contract";

const worldPath = resolve("src/core/world.ts");
const source = ts.createSourceFile(
  worldPath,
  readFileSync(worldPath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);
const failures: string[] = [];
const handlers = new Map<string, BuiltinNativeHandlerMutationKind>();

visit(source, (node) => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
  const method = node.expression.name.text;
  if (method === "registerBuiltinNativeHandler") {
    const [nameArg, mutationArg] = node.arguments;
    if (!nameArg || !ts.isStringLiteral(nameArg) || !mutationArg || !ts.isStringLiteral(mutationArg)) {
      failures.push(`${location(node)}: built-in native registration must use literal name and mutation class`);
      return;
    }
    if (mutationArg.text !== "read_only" && mutationArg.text !== "authoritative" && mutationArg.text !== "live_only") {
      failures.push(`${location(mutationArg)}: unknown native mutation class ${mutationArg.text}`);
      return;
    }
    if (handlers.has(nameArg.text)) failures.push(`${location(nameArg)}: duplicate built-in native handler ${nameArg.text}`);
    handlers.set(nameArg.text, mutationArg.text);
    return;
  }
  if (
    method === "set" &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === "nativeHandlers"
  ) {
    const owner = ancestorMethod(node);
    if (owner !== "registerNativeHandler" && owner !== "registerBuiltinNativeHandler") {
      failures.push(`${location(node)}: built-in native handlers must use registerBuiltinNativeHandler`);
    }
  }
});

failures.push(...nativePrimitiveContractDisciplineErrors(handlers));

if (failures.length > 0) {
  console.error("native failure-contract guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`native failure-contract guard passed (${handlers.size} built-in handlers)`);

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function ancestorMethod(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) return current.name.text;
    current = current.parent;
  }
  return null;
}

function location(node: ts.Node): string {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${worldPath}:${point.line + 1}:${point.character + 1}`;
}
