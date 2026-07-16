// @ts-ignore Node types are supplied by the test runner, not this extension.
import assert from "node:assert/strict";
// @ts-ignore Node types are supplied by the test runner, not this extension.
import test from "node:test";
import { convertLatexToUnicode } from "./converter.ts";

test("converts common notation", () => {
	assert.equal(convertLatexToUnicode(String.raw`Euler: $e^{i\pi}+1=0$`).text, "Euler: e^(iπ)+1=0");
	assert.equal(convertLatexToUnicode(String.raw`$\forall x \in \mathbb{R},\ x^2 \ge 0$`).text, "∀ x ∈ ℝ, x² ≥ 0");
	assert.equal(convertLatexToUnicode(String.raw`$\sqrt[3]{x+1} + \frac{a+b}{c}$`).text, "∛(x+1) + (a+b)/c");
	assert.equal(convertLatexToUnicode(String.raw`$\frac{1}{2}+\frac{1}{3}=\frac{5}{6}$`).text, "½+⅓=⅚");
	assert.equal(convertLatexToUnicode(String.raw`$\not\in, \not\Rightarrow, \neq$`).text, "∉, ⇏, ≠");
	assert.equal(convertLatexToUnicode(String.raw`$P \iff Q,\ P \implies Q,\ Q \impliedby P$`).text, "P ⇔ Q, P ⇒ Q, Q ⇐ P");
	assert.equal(convertLatexToUnicode(String.raw`$x \equiv y \pmod n$`).text, String.raw`x ≡ y \pmod n`);
	assert.equal(convertLatexToUnicode(String.raw`$x \equiv y \pmod{n}$`).text, "x ≡ y (mod n)");
});

test("covers complete mathematical Latin alphabets without dropping characters", () => {
	assert.equal(convertLatexToUnicode(String.raw`$\mathbb{R^2}$`).text, "ℝ²");
	assert.equal(convertLatexToUnicode(String.raw`$\mathfrak{GHI RZ}$`).text, "𝔊ℌℑ ℜℨ");
	assert.equal(convertLatexToUnicode(String.raw`$\mathcal{Begorz}$`).text, "ℬℯℊℴ𝓇𝓏");
	assert.equal(convertLatexToUnicode(String.raw`$\mathtt{A0z}$`).text, "𝙰𝟶𝚣");
});

test("uses PragmataPro's complete styled Greek alphabets", () => {
	assert.equal(convertLatexToUnicode(String.raw`$\mathbf{\Gamma\alpha\varphi\nabla}$`).text, "𝚪𝛂𝛟𝛁");
	assert.equal(convertLatexToUnicode(String.raw`$\mathit{\Omega\partial\varkappa}$`).text, "𝛺𝜕𝜘");
	assert.equal(convertLatexToUnicode(String.raw`$\symbfit{\Theta\beta\varrho}$`).text, "𝜣𝜷𝝔");
	assert.equal(convertLatexToUnicode(String.raw`$\mathsfbf{\Phi\sigma\varepsilon}$`).text, "𝝫𝞂𝞊");
	assert.equal(convertLatexToUnicode(String.raw`$\mathbfsfit{\Psi\omega\varpi}$`).text, "𝞧𝟂𝟉");
});

test("uses PragmataPro's available Unicode superscript letters", () => {
	assert.equal(convertLatexToUnicode("$x^{abc}+y^{TWO}$").text, "xᵃᵇᶜ+yᵀᵂᴼ");
	assert.equal(convertLatexToUnicode("$x^{Q}$").text, "x^Q");
});

test("handles delimiters, matrices, cases, and text", () => {
	assert.equal(convertLatexToUnicode(String.raw`$\left\langle x,y \right\rangle$`).text, "⟨ x,y ⟩");
	assert.equal(
		convertLatexToUnicode(String.raw`$\begin{bmatrix}a&b\\c&d\end{bmatrix}$`).text,
		"⎡a  b⎤\n⎣c  d⎦",
	);
	assert.equal(
		convertLatexToUnicode(String.raw`$$
\begin{bmatrix}a&b\\c&d\end{bmatrix}
\begin{pmatrix}x\\y\end{pmatrix}
=
\begin{pmatrix}ax+by\\cx+dy\end{pmatrix}
$$`).text,
		"⎡a  b⎤\u00a0⎛x⎞\u00a0\u00a0\u00a0⎛ax+by⎞\n⎣c  d⎦ ⎝y⎠ = ⎝cx+dy⎠",
	);
	assert.equal(
		convertLatexToUnicode(String.raw`$\begin{cases}x&\text{if }x>0\\-x&\text{otherwise}\end{cases}$`).text,
		"⎧ x, if x>0\n⎨\n⎩ -x, otherwise",
	);
});

test("collapses source lines and draws stretchable notation as terminal layouts", () => {
	assert.equal(
		convertLatexToUnicode(String.raw`$$\langle\mathbf{u},\mathbf{v}\rangle
=\mathbf{u}^{T}\mathbf{v},\qquad
\mathbf{u}\perp\mathbf{v}\iff\langle\mathbf{u},\mathbf{v}\rangle=0$$`).text,
		"⟨𝐮,𝐯⟩ =𝐮ᵀ𝐯,    𝐮⊥𝐯⇔⟨𝐮,𝐯⟩=0",
	);
	assert.equal(
		convertLatexToUnicode(String.raw`$\overbrace{a+b+c}^{n\text{ terms}}$`).text,
		"n terms\n╭──┴──╮\n\u00a0a+b+c",
	);
	assert.equal(
		convertLatexToUnicode(String.raw`$\underbrace{x_1+\cdots+x_n}_{\text{sample}}$`).text,
		"x₁+⋯+xₙ\n╰──┬──╯\n\u00a0sample",
	);
});

test("preserves code spans and fences, including multiline code spans", () => {
	const input = [
		String.raw`Convert $x^2$, not \`$y_1$\`.`,
		"``code $z^3$\ncontinues``",
		"```tex",
		String.raw`$\alpha$`,
		"```",
	].join("\n");
	const expected = [
		String.raw`Convert x², not \`$y_1$\`.`,
		"``code $z^3$\ncontinues``",
		"```tex",
		String.raw`$\alpha$`,
		"```",
	].join("\n");
	assert.equal(convertLatexToUnicode(input).text, expected);
});

test("does not mistake escaped dollars, currency, or whitespace delimiters for math", () => {
	for (const input of [String.raw`Price: \$5 and $10`, "$5 and $10", "$ x $", "empty $$ pair"]) {
		assert.deepEqual(convertLatexToUnicode(input), { text: input, changed: false });
	}
	assert.equal(convertLatexToUnicode(String.raw`Price: \$5; variable: $x$`).text, String.raw`Price: \$5; variable: x`);
});

test("preserves unknown and malformed commands rather than losing operands", () => {
	assert.equal(convertLatexToUnicode(String.raw`$\unknown{x}+1$`).text, String.raw`\unknown{x}+1`);
	assert.equal(convertLatexToUnicode(String.raw`$\frac{a}$`).text, String.raw`\frac{a}`);
	assert.equal(convertLatexToUnicode(String.raw`$\sqrt[3{x}$`).text, String.raw`\sqrt[3{x}`);
});

test("reports changes in one scan", () => {
	assert.deepEqual(convertLatexToUnicode("plain text"), { text: "plain text", changed: false });
	assert.deepEqual(convertLatexToUnicode("$x_1$"), { text: "x₁", changed: true });
});
