const UNRENDERED_EXPRESSIONS = [
  /\{\{[\s\S]*?\}\}|\{\{[^\n]*/,
  /\$\{[\s\S]*?\}|\$\{[^\n]*/,
  /<%[\s\S]*?%>|<%[^\n]*/,
  /\[object Object\]/,
  /\bundefined\b/,
  /\bNaN\b/,
];

export function unrenderedExpressionIn(text: string | null | undefined): string | null {
  const subject = text ?? "";
  for (const pattern of UNRENDERED_EXPRESSIONS) {
    const found = subject.match(pattern);
    if (found) return found[0];
  }
  return null;
}

export function carriesAnUnrenderedExpression(text: string | null | undefined): boolean {
  return unrenderedExpressionIn(text) !== null;
}
