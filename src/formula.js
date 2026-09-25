/**
 * 指标公式的安全求值器。
 *
 * 口径中的公式（如 "num/den*100"）以文本形式随版本保存，求值时只允许
 * 数字、num/den 等已声明变量与 + - * / ( )，不执行任意代码。
 * 分母为零等异常会得到非有限值，由调用方转成质量标记而不是抛出。
 */
export function evaluateFormula(formula, vars) {
  const tokens = tokenize(formula);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let left = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const right = parseFactor();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }

  function parseFactor() {
    const tk = next();
    if (tk === undefined) throw new Error("公式意外结束");
    if (tk === "(") {
      const value = parseExpr();
      if (next() !== ")") throw new Error("括号不配对");
      return value;
    }
    if (tk === "-") return -parseFactor();
    if (/^\d/.test(tk)) return Number(tk);
    if (Object.hasOwn(vars, tk)) return vars[tk];
    throw new Error(`未知变量：${tk}`);
  }

  const value = parseExpr();
  if (pos !== tokens.length) throw new Error("公式存在多余内容");
  return value;
}

function tokenize(formula) {
  if (typeof formula !== "string" || formula.trim() === "") throw new Error("公式不能为空");
  const tokens = [];
  const re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/y;
  let i = 0;
  while (i < formula.length) {
    re.lastIndex = i;
    const m = re.exec(formula);
    if (!m) {
      if (formula.slice(i).trim() === "") break;
      throw new Error(`公式含无法识别的内容：${formula.slice(i)}`);
    }
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  return tokens;
}
