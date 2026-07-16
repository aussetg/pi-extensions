/**
 * Loss-preserving LaTeX-math to semantic Unicode for PragmataPro.
 *
 * This is deliberately not a TeX engine. It handles the notation models most
 * often put in Markdown messages and leaves unknown or malformed input intact.
 * Code spans and fenced code blocks are never converted.
 */

type StringMap = Readonly<Record<string, string>>;

const greek: StringMap = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ϵ",
	zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
	lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
	rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
	phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω", varkappa: "ϰ",
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
	Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", varTheta: "ϴ",
};

const operators: StringMap = {
	sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", iiiint: "⨌",
	oint: "∮", oiint: "∯", oiiint: "∰", bigcup: "⋃", bigcap: "⋂", bigsqcup: "⨆",
	bigvee: "⋁", bigwedge: "⋀", bigoplus: "⨁", bigotimes: "⨂", bigodot: "⨀",
	wedge: "∧", land: "∧", vee: "∨", lor: "∨", cap: "∩", cup: "∪",
	setminus: "∖", smallsetminus: "∖", cdot: "·", cdotp: "·", times: "×", div: "÷",
	ast: "∗", star: "⋆", circ: "∘", bullet: "∙", diamond: "⋄", pm: "±", mp: "∓",
	oplus: "⊕", ominus: "⊖", otimes: "⊗", oslash: "⊘", odot: "⊙", circledast: "⊛",
	circledcirc: "⊚", circleddash: "⊝", boxplus: "⊞", boxminus: "⊟", boxtimes: "⊠",
	boxdot: "⊡", uplus: "⊎", sqcap: "⊓", sqcup: "⊔", wr: "≀", amalg: "∐",
	dagger: "†", ddagger: "‡", triangleleft: "◁", triangleright: "▷",
	vartriangleleft: "⊲", vartriangleright: "⊳", lhd: "⊲", rhd: "⊳",
	unlhd: "⊴", unrhd: "⊵", bigtriangleup: "△", bigtriangledown: "▽",
};

const relations: StringMap = {
	ne: "≠", neq: "≠", le: "≤", leq: "≤", ge: "≥", geq: "≥", ll: "≪", gg: "≫",
	equiv: "≡", approx: "≈", approxeq: "≊", sim: "∼", simeq: "≃", cong: "≅",
	doteq: "≐", asymp: "≍", propto: "∝", parallel: "∥", nparallel: "∦", perp: "⊥",
	mid: "∣", nmid: "∤", in: "∈", ni: "∋", owns: "∋", notin: "∉",
	subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇", subsetneq: "⊊",
	supsetneq: "⊋", nsubseteq: "⊈", nsupseteq: "⊉", sqsubset: "⊏", sqsupset: "⊐",
	sqsubseteq: "⊑", sqsupseteq: "⊒", prec: "≺", succ: "≻", preceq: "⪯",
	succeq: "⪰", precsim: "≾", succsim: "≿", lesssim: "≲", gtrsim: "≳",
	lessapprox: "⪅", gtrapprox: "⪆", nsim: "≁", ncong: "≇", triangleq: "≜",
	nless: "≮", ngtr: "≯", nleq: "≰", ngeq: "≱", nprec: "⊀", nsucc: "⊁",
	lll: "⋘", llless: "⋘", ggg: "⋙", gggtr: "⋙",
	bowtie: "⋈", smile: "⌣", frown: "⌢", pitchfork: "⋔",
	vdash: "⊢", dashv: "⊣", Vdash: "⊩", vDash: "⊨", Vvdash: "⊪", models: "⊨",
};

const arrows: StringMap = {
	leftarrow: "←", gets: "←", rightarrow: "→", to: "→", leftrightarrow: "↔",
	Leftarrow: "⇐", Rightarrow: "⇒", Leftrightarrow: "⇔", uparrow: "↑", downarrow: "↓",
	iff: "⇔", implies: "⇒", impliedby: "⇐",
	updownarrow: "↕", Uparrow: "⇑", Downarrow: "⇓", Updownarrow: "⇕",
	nwarrow: "↖", nearrow: "↗", searrow: "↘", swarrow: "↙", mapsto: "↦",
	longmapsto: "⟼", hookleftarrow: "↩", hookrightarrow: "↪", leftharpoonup: "↼",
	leftharpoondown: "↽", rightharpoonup: "⇀", rightharpoondown: "⇁",
	rightleftharpoons: "⇌", leftrightharpoons: "⇋", leadsto: "⇝", rightsquigarrow: "⇝",
	leftsquigarrow: "⇜", longleftarrow: "⟵", longrightarrow: "⟶", longleftrightarrow: "⟷",
	Longleftarrow: "⟸", Longrightarrow: "⟹", Longleftrightarrow: "⟺",
	woheadleftarrow: "↞", twoheadrightarrow: "↠", leftleftarrows: "⇇", rightrightarrows: "⇉",
	dashleftarrow: "⇠", dashrightarrow: "⇢", Lleftarrow: "⇚", Rrightarrow: "⇛",
};

const symbols: StringMap = {
	infty: "∞", infinity: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
	nexists: "∄", emptyset: "∅", varnothing: "∅", complement: "∁", aleph: "ℵ", beth: "ℶ",
	gimel: "ℷ", daleth: "ℸ", ell: "ℓ", wp: "℘", hbar: "ℏ", imath: "ı", jmath: "ȷ",
	Re: "ℜ", Im: "ℑ", top: "⊤", bot: "⊥", angle: "∠", measuredangle: "∡",
	sphericalangle: "∢", therefore: "∴", because: "∵", neg: "¬", lnot: "¬",
	checkmark: "✓", maltese: "✠", flat: "♭", natural: "♮", sharp: "♯",
	prime: "′", dprime: "″", primes: "″", ldots: "…", dots: "…", dotsc: "…",
	dotso: "…", cdots: "⋯", dotsb: "⋯", dotsm: "⋯", dotsi: "⋯", vdots: "⋮",
	ddots: "⋱", colon: "∶", surd: "√", Box: "□", square: "□",
	triangle: "△", blacktriangle: "▲", blacksquare: "■", lozenge: "◊",
	langle: "⟨", rangle: "⟩", lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
	lbrack: "[", rbrack: "]",
	lbrace: "{", rbrace: "}", vert: "|", lvert: "|", rvert: "|",
	Vert: "‖", lVert: "‖", rVert: "‖", backslash: "∖", slash: "/",
	quad: "  ", qquad: "    ", enspace: " ", thinspace: " ", nobreakspace: " ",
	space: " ", negthinspace: "",
};

const commandMap: StringMap = { ...greek, ...operators, ...relations, ...arrows, ...symbols };

const namedFunctions: StringMap = {
	sin: "sin", cos: "cos", tan: "tan", cot: "cot", sec: "sec", csc: "csc",
	arcsin: "arcsin", arccos: "arccos", arctan: "arctan", sinh: "sinh", cosh: "cosh",
	tanh: "tanh", coth: "coth", log: "log", ln: "ln", exp: "exp", lim: "lim",
	limsup: "lim sup", liminf: "lim inf", max: "max", min: "min", sup: "sup", inf: "inf",
	det: "det", dim: "dim", ker: "ker", hom: "hom", gcd: "gcd", deg: "deg",
	arg: "arg", Pr: "Pr", mod: "mod", bmod: "mod",
};

const superscripts: StringMap = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
	"7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
	")": "⁾",
	A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ",
	L: "ᴸ", M: "ᴹ", N: "ᴺ", O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
	a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ",
	j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ",
	t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};

const subscripts: StringMap = {
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
	"7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
	")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ",
	n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

interface Group {
	content: string;
	end: number;
}

function parseGroup(text: string, start: number, open = "{", close = "}"): Group | null {
	if (text[start] !== open) return null;
	let depth = 1;
	for (let i = start + 1; i < text.length; i += 1) {
		if (text[i] === "\\") {
			i += 1;
			continue;
		}
		if (text[i] === open) depth += 1;
		else if (text[i] === close && --depth === 0) {
			return { content: text.slice(start + 1, i), end: i + 1 };
		}
	}
	return null;
}

function makeAlphabet(
	upperStart: number,
	lowerStart: number,
	digitStart?: number,
	exceptions: StringMap = {},
): (character: string) => string | undefined {
	return (character) => {
		if (exceptions[character]) return exceptions[character];
		const code = character.codePointAt(0);
		if (code === undefined) return undefined;
		if (code >= 65 && code <= 90) return String.fromCodePoint(upperStart + code - 65);
		if (code >= 97 && code <= 122) return String.fromCodePoint(lowerStart + code - 97);
		if (digitStart !== undefined && code >= 48 && code <= 57) {
			return String.fromCodePoint(digitStart + code - 48);
		}
		return undefined;
	};
}

type Font = (character: string) => string | undefined;

// The five styled Greek alphabets are contiguous in Unicode. The source order
// below follows those blocks exactly, including variant symbols. PragmataPro
// 0.903 contains every resulting glyph.
const greekAlphabetOrder = [
	..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇",
	..."αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ",
];

function addGreek(font: Font, greekStart: number): Font {
	const styledGreek = new Map(greekAlphabetOrder.map((character, index) => [character, String.fromCodePoint(greekStart + index)]));
	return (character) => font(character) ?? styledGreek.get(character);
}

const fonts: Readonly<Record<string, Font>> = {
	mathbb: makeAlphabet(0x1d538, 0x1d552, 0x1d7d8, {
		C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ",
	}),
	mathbf: addGreek(makeAlphabet(0x1d400, 0x1d41a, 0x1d7ce), 0x1d6a8),
	boldsymbol: addGreek(makeAlphabet(0x1d400, 0x1d41a, 0x1d7ce), 0x1d6a8),
	mathit: addGreek(makeAlphabet(0x1d434, 0x1d44e, undefined, { h: "ℎ" }), 0x1d6e2),
	mathbfit: addGreek(makeAlphabet(0x1d468, 0x1d482), 0x1d71c),
	mathcal: makeAlphabet(0x1d49c, 0x1d4b6, undefined, {
		B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ",
		e: "ℯ", g: "ℊ", o: "ℴ",
	}),
	mathscr: makeAlphabet(0x1d49c, 0x1d4b6, undefined, {
		B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ",
		e: "ℯ", g: "ℊ", o: "ℴ",
	}),
	mathfrak: makeAlphabet(0x1d504, 0x1d51e, undefined, {
		C: "ℭ", H: "ℌ", I: "ℑ", R: "ℜ", Z: "ℨ",
	}),
	mathbffrak: makeAlphabet(0x1d56c, 0x1d586),
	mathsf: makeAlphabet(0x1d5a0, 0x1d5ba, 0x1d7e2),
	mathsfbf: addGreek(makeAlphabet(0x1d5d4, 0x1d5ee, 0x1d7ec), 0x1d756),
	mathsfit: makeAlphabet(0x1d608, 0x1d622),
	mathbfsfit: addGreek(makeAlphabet(0x1d63c, 0x1d656), 0x1d790),
	mathtt: makeAlphabet(0x1d670, 0x1d68a, 0x1d7f6),
};

const fontAliases: StringMap = {
	bb: "mathbb", bf: "mathbf", bfit: "mathbfit", cal: "mathcal", scr: "mathscr",
	frak: "mathfrak", sf: "mathsf", tt: "mathtt", bm: "boldsymbol",
	symbb: "mathbb", symbf: "mathbf", symit: "mathit", symbfit: "mathbfit",
	symcal: "mathcal", symscr: "mathscr", symfrak: "mathfrak", symbffrak: "mathbffrak",
	symsf: "mathsf", symsfbf: "mathsfbf", symsfit: "mathsfit", symbfsfit: "mathbfsfit",
	symtt: "mathtt",
};

function applyFont(text: string, font: Font): string {
	return [...text].map((character) => font(character) ?? character).join("");
}

function canMap(text: string, map: StringMap): boolean {
	return [...text].every((character) => map[character] !== undefined);
}

function mapCharacters(text: string, map: StringMap): string {
	return [...text].map((character) => map[character] ?? character).join("");
}

function formatScript(text: string, marker: "^" | "_"): string {
	const map = marker === "^" ? superscripts : subscripts;
	const characters = [...text];
	if (characters.length <= 8 && canMap(text, map)) return mapCharacters(text, map);
	return characters.length <= 1 ? `${marker}${text}` : `${marker}(${text})`;
}

function skipHorizontalSpace(text: string, start: number): number {
	let i = start;
	while (text[i] === " " || text[i] === "\t") i += 1;
	return i;
}

function readCommand(text: string, slash: number): { name: string; end: number } {
	let end = slash + 1;
	while (end < text.length && /[A-Za-z]/.test(text[end]!)) end += 1;
	return { name: text.slice(slash + 1, end), end };
}

function parenthesize(value: string): string {
	return [...value].length <= 1 || /^\([^()]*\)$/.test(value) ? value : `(${value})`;
}

const vulgarFractions: StringMap = {
	"1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕",
	"2/5": "⅖", "3/5": "⅗", "4/5": "⅘", "1/6": "⅙", "5/6": "⅚", "1/7": "⅐",
	"1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞", "1/9": "⅑", "1/10": "⅒",
};

const negations: StringMap = {
	"=": "≠", "<": "≮", ">": "≯", "≤": "≰", "≥": "≱", "∈": "∉", "∋": "∌",
	"⊂": "⊄", "⊃": "⊅", "⊆": "⊈", "⊇": "⊉", "∥": "∦", "∣": "∤", "∼": "≁",
	"≈": "≉", "≃": "≄", "≅": "≇", "≡": "≢", "≺": "⊀", "≻": "⊁", "←": "↚",
	"→": "↛", "↔": "↮", "⇐": "⇍", "⇒": "⇏", "⇔": "⇎", "⊢": "⊬", "⊨": "⊭",
};

const accents: StringMap = {
	hat: "̂", widehat: "̂", bar: "̄", overline: "̅", vec: "⃗", overrightarrow: "⃗",
	overleftarrow: "⃖", tilde: "̃", widetilde: "̃", dot: "̇", ddot: "̈", breve: "̆",
	check: "̌", acute: "́", grave: "̀", underline: "̲",
};

const delimiterCommands = new Set([
	"left", "right", "middle", "big", "Big", "bigg", "Bigg", "bigl", "bigr",
	"Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr",
]);

const ignoredLayoutCommands = new Set([
	"displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "limits", "nolimits",
]);

const textCommands = new Set([
	"operatorname", "mathrm", "text", "textrm", "textnormal", "textbf", "textit", "texttt",
]);

const supportedEnvironments = new Set([
	"cases", "aligned", "align", "alignedat", "array", "matrix", "pmatrix", "bmatrix",
	"Bmatrix", "vmatrix", "Vmatrix", "smallmatrix",
]);

function applyAccent(text: string, accent: string): string {
	return [...text].map((character) => /\s/.test(character) ? character : character + accent).join("");
}

function parseDelimiter(text: string, start: number): { text: string; end: number } | null {
	const i = skipHorizontalSpace(text, start);
	if (i >= text.length) return null;
	if (text[i] !== "\\") {
		return { text: text[i] === "." ? "" : text[i]!, end: i + 1 };
	}
	const command = readCommand(text, i);
	if (!command.name) {
		const escaped = text[i + 1];
		if (escaped === undefined) return null;
		return { text: escaped === "|" ? "‖" : escaped, end: i + 2 };
	}
	const delimiter = symbols[command.name];
	if (delimiter === undefined) return null;
	return { text: delimiter, end: command.end };
}

function splitEnvironmentRows(body: string): string[][] {
	const rows: string[][] = [[]];
	let cell = "";
	let depth = 0;
	for (let i = 0; i < body.length; i += 1) {
		const character = body[i]!;
		if (character === "{" && !isEscaped(body, i)) depth += 1;
		else if (character === "}" && !isEscaped(body, i)) depth = Math.max(0, depth - 1);
		if (depth === 0 && character === "&") {
			rows[rows.length - 1]!.push(cell);
			cell = "";
			continue;
		}
		if (depth === 0 && character === "\\" && body[i + 1] === "\\") {
			rows[rows.length - 1]!.push(cell);
			rows.push([]);
			cell = "";
			i += 1;
			continue;
		}
		cell += character;
	}
	rows[rows.length - 1]!.push(cell);
	return rows;
}

const MATH_LAYOUT_START = "\uE000";
const MATH_LAYOUT_END = "\uE001";
const LAYOUT_SPACE = "\u00a0";

interface MathLayout {
	lines: string[];
	baseline: number;
}

function encodeMathLayout(layout: MathLayout): string {
	return `${MATH_LAYOUT_START}${JSON.stringify(layout)}${MATH_LAYOUT_END}`;
}

function horizontalLayout(left: MathLayout, right: MathLayout): MathLayout {
	const baseline = Math.max(left.baseline, right.baseline);
	const depth = Math.max(left.lines.length - left.baseline, right.lines.length - right.baseline);
	const height = baseline + depth;
	const leftWidth = Math.max(0, ...left.lines.map((line) => [...line].length));
	const lines = Array.from({ length: height }, (_, row) => {
		const leftRow = row - baseline + left.baseline;
		const rightRow = row - baseline + right.baseline;
		const leftLine = left.lines[leftRow] ?? "";
		const rightLine = right.lines[rightRow] ?? "";
		return leftLine + LAYOUT_SPACE.repeat(leftWidth - [...leftLine].length) + rightLine;
	});
	return { lines, baseline };
}

function resolveMathLayouts(text: string): string {
	if (!text.includes(MATH_LAYOUT_START)) return text;
	const parts: MathLayout[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf(MATH_LAYOUT_START, cursor);
		if (start === -1) {
			const plain = text.slice(cursor).replace(/\s+/g, " ");
			if (plain.trim()) parts.push({ lines: [plain], baseline: 0 });
			break;
		}
		const plain = text.slice(cursor, start).replace(/\s+/g, " ");
		if (plain && (parts.length > 0 || plain.trim())) parts.push({ lines: [plain], baseline: 0 });
		const end = text.indexOf(MATH_LAYOUT_END, start + 1);
		if (end === -1) return text;
		parts.push(JSON.parse(text.slice(start + 1, end)) as MathLayout);
		cursor = end + 1;
	}
	if (parts.length === 0) return "";
	const layout = parts.slice(1).reduce(horizontalLayout, parts[0]!);
	return layout.lines.map((line) => line.trimEnd()).join("\n");
}

function matrixBrackets(name: string, row: number, rowCount: number): readonly [string, string] {
	if (rowCount === 1) {
		const wrappers: Readonly<Record<string, readonly [string, string]>> = {
			pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"],
			vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"],
		};
		return wrappers[name] ?? ["", ""];
	}
	const position = row === 0 ? 0 : row === rowCount - 1 ? 2 : 1;
	const wrappers: Readonly<Record<string, readonly [string, string]>> = {
		pmatrix: ["⎛⎜⎝"[position]!, "⎞⎟⎠"[position]!],
		bmatrix: ["⎡⎢⎣"[position]!, "⎤⎥⎦"[position]!],
		Bmatrix: ["⎧⎪⎩"[position]!, "⎫⎪⎭"[position]!],
		vmatrix: ["│", "│"], Vmatrix: ["║", "║"],
	};
	return wrappers[name] ?? ["", ""];
}

function centerText(text: string, width: number): string {
	const padding = Math.max(0, width - [...text].length);
	const left = Math.ceil(padding / 2);
	return LAYOUT_SPACE.repeat(left) + text + LAYOUT_SPACE.repeat(padding - left);
}

function braceRule(width: number, over: boolean): string {
	const innerWidth = Math.max(1, width - 2);
	const leftWidth = Math.floor((innerWidth - 1) / 2);
	const rightWidth = innerWidth - leftWidth - 1;
	return (over ? "╭" : "╰") + "─".repeat(leftWidth) + (over ? "┴" : "┬") +
		"─".repeat(rightWidth) + (over ? "╮" : "╯");
}

function renderBrace(name: "overbrace" | "underbrace", body: string, annotation: string): string {
	const width = Math.max(3, [...body].length, [...annotation].length);
	const bodyLine = centerText(body, width);
	const annotationLine = centerText(annotation, width);
	const over = name === "overbrace";
	const lines = over
		? [annotationLine, braceRule(width, true), bodyLine]
		: [bodyLine, braceRule(width, false), annotationLine];
	return encodeMathLayout({ lines, baseline: over ? 2 : 0 });
}

function renderEnvironment(name: string, body: string): string {
	const rows = splitEnvironmentRows(body).map((row) => row.map((cell) => convertMathExprRaw(cell).trim()));
	if (name === "cases") {
		const contents = rows.map((row) => row.join(", "));
		if (contents.length === 1) return encodeMathLayout({ lines: [`{ ${contents[0]}`], baseline: 0 });
		if (contents.length === 2) {
			return encodeMathLayout({
				lines: [`⎧ ${contents[0]}`, "⎨", `⎩ ${contents[1]}`],
				baseline: 1,
			});
		}
		const middle = Math.floor(contents.length / 2);
		const lines = contents.map((content, row) => {
			const bracket = row === 0 ? "⎧" : row === contents.length - 1 ? "⎩" : row === middle ? "⎨" : "⎪";
			return `${bracket} ${content}`;
		});
		return encodeMathLayout({ lines, baseline: middle });
	}
	if (name === "aligned" || name === "align" || name === "alignedat") {
		const lines = rows.map((row) => row.join("  "));
		return encodeMathLayout({ lines, baseline: Math.floor(lines.length / 2) });
	}
	const columnCount = Math.max(0, ...rows.map((row) => row.length));
	const widths = Array.from({ length: columnCount }, (_, column) =>
		Math.max(0, ...rows.map((row) => [...(row[column] ?? "")].length)));
	const lines = rows.map((row, rowIndex) => {
		const cells = Array.from({ length: columnCount }, (_, column) => {
			const cell = row[column] ?? "";
			return column === columnCount - 1 ? cell : cell + " ".repeat(widths[column]! - [...cell].length);
		});
		const [left, right] = matrixBrackets(name, rowIndex, rows.length);
		return `${left}${cells.join("  ")}${right}`;
	});
	return encodeMathLayout({ lines, baseline: Math.floor(lines.length / 2) });
}

interface CommandConversion {
	text: string;
	end: number;
}

function convertCommand(expression: string, slash: number): CommandConversion {
	const command = readCommand(expression, slash);
	if (!command.name) {
		const escaped = expression[slash + 1];
		if (escaped === undefined) return { text: "\\", end: slash + 1 };
		const escapedMap: StringMap = {
			"$": "$", "#": "#", "%": "%", "&": "&", "_": "_", "{": "{", "}": "}",
			"~": " ", " ": " ", "|": "‖", ",": " ", ";": " ", ":": " ", "!": "",
		};
		return { text: escapedMap[escaped] ?? `\\${escaped}`, end: slash + 2 };
	}

	const { name } = command;
	let argumentStart = skipHorizontalSpace(expression, command.end);

	if (delimiterCommands.has(name)) {
		const delimiter = parseDelimiter(expression, command.end);
		return delimiter ?? { text: `\\${name}`, end: command.end };
	}

	if (ignoredLayoutCommands.has(name)) {
		return { text: "", end: command.end };
	}

	if (name === "frac" || name === "dfrac" || name === "tfrac") {
		const numerator = parseGroup(expression, argumentStart);
		const denominatorStart = numerator ? skipHorizontalSpace(expression, numerator.end) : argumentStart;
		const denominator = numerator ? parseGroup(expression, denominatorStart) : null;
		if (!numerator) return { text: `\\${name}`, end: command.end };
		if (!denominator) {
			return { text: expression.slice(slash, numerator.end), end: numerator.end };
		}
		const top = convertMathExprRaw(numerator.content).trim();
		const bottom = convertMathExprRaw(denominator.content).trim();
		const vulgar = vulgarFractions[`${top}/${bottom}`];
		return {
			text: vulgar ?? `${parenthesize(top)}/${parenthesize(bottom)}`,
			end: denominator.end,
		};
	}

	if (name === "sqrt") {
		let degree = "";
		if (expression[argumentStart] === "[") {
			const group = parseGroup(expression, argumentStart, "[", "]");
			if (!group) return { text: expression.slice(slash), end: expression.length };
			degree = convertMathExprRaw(group.content).trim();
			argumentStart = skipHorizontalSpace(expression, group.end);
		}
		const radicand = parseGroup(expression, argumentStart);
		if (!radicand) return { text: "\\sqrt", end: command.end };
		const inner = convertMathExprRaw(radicand.content).trim();
		const radical = degree === "3" ? "∛" : degree === "4" ? "∜" : `${degree ? formatScript(degree, "^") : ""}√`;
		return { text: `${radical}${parenthesize(inner)}`, end: radicand.end };
	}

	if (name === "binom" || name === "tbinom" || name === "dbinom") {
		const top = parseGroup(expression, argumentStart);
		const bottom = top ? parseGroup(expression, skipHorizontalSpace(expression, top.end)) : null;
		if (!top || !bottom) return { text: `\\${name}`, end: command.end };
		return { text: `C(${convertMathExprRaw(top.content)}, ${convertMathExprRaw(bottom.content)})`, end: bottom.end };
	}

	if (name === "overset" || name === "underset" || name === "stackrel") {
		const annotation = parseGroup(expression, argumentStart);
		const base = annotation ? parseGroup(expression, skipHorizontalSpace(expression, annotation.end)) : null;
		if (!annotation || !base) return { text: `\\${name}`, end: command.end };
		const marker = name === "underset" ? "_" : "^";
		return {
			text: `${convertMathExprRaw(base.content)}${formatScript(convertMathExprRaw(annotation.content), marker)}`,
			end: base.end,
		};
	}

	if (textCommands.has(name)) {
		if (expression[argumentStart] === "*") argumentStart = skipHorizontalSpace(expression, argumentStart + 1);
		const group = parseGroup(expression, argumentStart);
		if (!group) return { text: `\\${name}`, end: command.end };
		return { text: group.content.replace(/\\([#$%&_{}])/g, "$1"), end: group.end };
	}

	if (name === "pmod" || name === "pod") {
		const group = parseGroup(expression, argumentStart);
		if (!group) return { text: `\\${name}`, end: command.end };
		const content = convertMathExprRaw(group.content);
		return { text: name === "pmod" ? `(mod ${content})` : `(${content})`, end: group.end };
	}

	if (name === "substack") {
		const group = parseGroup(expression, argumentStart);
		if (!group) return { text: "\\substack", end: command.end };
		return { text: group.content.split(/\\\\/).map((line) => convertMathExprRaw(line).trim()).join(", "), end: group.end };
	}

	const canonicalFont = fonts[name] ? name : fontAliases[name];
	if (canonicalFont) {
		const font = fonts[canonicalFont]!;
		const group = parseGroup(expression, argumentStart);
		if (group) {
			return { text: applyFont(convertMathExprRaw(group.content), font), end: group.end };
		}
		const character = expression[argumentStart];
		if (character && /[A-Za-z0-9]/.test(character)) {
			return { text: font(character) ?? character, end: argumentStart + 1 };
		}
		return { text: `\\${name}`, end: command.end };
	}

	if (accents[name]) {
		const group = parseGroup(expression, argumentStart);
		if (!group) return { text: `\\${name}`, end: command.end };
		return { text: applyAccent(convertMathExprRaw(group.content), accents[name]!), end: group.end };
	}

	if (name === "overbrace" || name === "underbrace") {
		const group = parseGroup(expression, argumentStart);
		if (!group) return { text: `\\${name}`, end: command.end };
		const body = convertMathExprRaw(group.content);
		const marker = name === "overbrace" ? "^" : "_";
		const scriptStart = skipHorizontalSpace(expression, group.end);
		if (expression[scriptStart] !== marker) {
			return { text: renderBrace(name, body, ""), end: group.end };
		}
		const annotationStart = skipHorizontalSpace(expression, scriptStart + 1);
		const annotationGroup = parseGroup(expression, annotationStart);
		if (annotationGroup) {
			return {
				text: renderBrace(name, body, convertMathExprRaw(annotationGroup.content).trim()),
				end: annotationGroup.end,
			};
		}
		const annotation = expression[annotationStart];
		if (!annotation) return { text: renderBrace(name, body, ""), end: group.end };
		return { text: renderBrace(name, body, annotation), end: annotationStart + 1 };
	}

	if (name === "not") {
		const targetStart = skipHorizontalSpace(expression, command.end);
		let targetText = expression[targetStart] ?? "";
		let targetEnd = targetStart + (targetText ? 1 : 0);
		if (targetText === "\\") {
			const target = readCommand(expression, targetStart);
			const mapped = commandMap[target.name];
			if (mapped !== undefined) {
				targetText = mapped;
				targetEnd = target.end;
			} else {
				return { text: "\\not", end: command.end };
			}
		}
		if (!targetText) return { text: "\\not", end: command.end };
		return { text: negations[targetText] ?? `${targetText}̸`, end: targetEnd };
	}

	if (name === "begin") {
		const environment = parseGroup(expression, argumentStart);
		if (!environment) return { text: "\\begin", end: command.end };
		if (!supportedEnvironments.has(environment.content)) return { text: "\\begin", end: command.end };
		let bodyStart = environment.end;
		if (environment.content === "array") {
			const columns = parseGroup(expression, skipHorizontalSpace(expression, bodyStart));
			if (columns) bodyStart = columns.end;
		}
		const endMarker = `\\end{${environment.content}}`;
		const end = expression.indexOf(endMarker, bodyStart);
		if (end === -1) return { text: "\\begin", end: command.end };
		return {
			text: renderEnvironment(environment.content, expression.slice(bodyStart, end)),
			end: end + endMarker.length,
		};
	}

	if (name === "color" || name === "textcolor" || name === "colorbox") {
		const color = parseGroup(expression, argumentStart);
		const body = color ? parseGroup(expression, skipHorizontalSpace(expression, color.end)) : null;
		if (!color || !body) return { text: `\\${name}`, end: command.end };
		return { text: convertMathExprRaw(body.content), end: body.end };
	}

	if (namedFunctions[name] !== undefined) return { text: namedFunctions[name]!, end: command.end };
	if (commandMap[name] !== undefined) return { text: commandMap[name]!, end: command.end };

	// Unknown macros may have semantics we cannot approximate. Keep their
	// immediately following arguments byte-for-byte instead of stripping TeX
	// grouping braces or partially converting their contents.
	let unknownEnd = command.end;
	let next = skipHorizontalSpace(expression, unknownEnd);
	while (expression[next] === "{") {
		const group = parseGroup(expression, next);
		if (!group) break;
		unknownEnd = group.end;
		next = skipHorizontalSpace(expression, unknownEnd);
	}
	return { text: expression.slice(slash, unknownEnd), end: unknownEnd };
}

function convertMathExprRaw(expression: string): string {
	let result = "";
	let i = 0;
	while (i < expression.length) {
		const character = expression[i]!;
		if (/\s/.test(character)) {
			while (i < expression.length && /\s/.test(expression[i]!)) i += 1;
			if (result && !result.endsWith(" ")) result += " ";
			continue;
		}
		if (character === "\\") {
			const converted = convertCommand(expression, i);
			result += converted.text;
			i = converted.end;
			continue;
		}
		if (character === "^" || character === "_") {
			const marker = character;
			const group = parseGroup(expression, i + 1);
			if (group) {
				result += formatScript(convertMathExprRaw(group.content), marker);
				i = group.end;
				continue;
			}
			if (expression[i + 1] === "\\") {
				const converted = convertCommand(expression, i + 1);
				result += formatScript(converted.text, marker);
				i = converted.end;
				continue;
			}
			if (i + 1 < expression.length) {
				result += formatScript(expression[i + 1]!, marker);
				i += 2;
				continue;
			}
		}
		if (character === "{") {
			const group = parseGroup(expression, i);
			if (group) {
				result += convertMathExprRaw(group.content);
				i = group.end;
				continue;
			}
		}
		if (character === "'") {
			let count = 1;
			while (expression[i + count] === "'") count += 1;
			result += count === 1 ? "′" : count === 2 ? "″" : count === 3 ? "‴" : "′".repeat(count);
			i += count;
			continue;
		}
		result += character;
		i += 1;
	}
	return result;
}

function convertMathExpr(expression: string): string {
	const converted = convertMathExprRaw(expression);
	return converted.includes(MATH_LAYOUT_START) ? resolveMathLayouts(converted) : converted.trim();
}

type SegmentKind = "text" | "inlineCode" | "fencedCode" | "inlineMath" | "displayMath";

interface Segment {
	kind: SegmentKind;
	raw: string;
	content?: string;
}

interface FenceInfo {
	character: "`" | "~";
	length: number;
}

function nextLineEnd(text: string, start: number): number {
	const newline = text.indexOf("\n", start);
	return newline === -1 ? text.length : newline + 1;
}

function stripLineEnding(line: string): string {
	return line.replace(/[\r\n]+$/, "");
}

function parseFenceOpener(line: string): FenceInfo | null {
	const match = stripLineEnding(line).match(/^(?: {0,3}|(?: {0,3}>[ \t]*)+)(`{3,}|~{3,})([^\r\n]*)$/);
	if (!match) return null;
	const fence = match[1]!;
	if (fence[0] === "`" && (match[2] ?? "").includes("`")) return null;
	return { character: fence[0] as "`" | "~", length: fence.length };
}

function isFenceCloser(line: string, opener: FenceInfo): boolean {
	const match = stripLineEnding(line).match(/^(?: {0,3}|(?: {0,3}>[ \t]*)+)(`{3,}|~{3,})[ \t]*$/);
	const fence = match?.[1];
	return Boolean(fence && fence[0] === opener.character && fence.length >= opener.length);
}

function findFenceEnd(text: string, start: number, opener: FenceInfo): number {
	let cursor = start;
	while (cursor < text.length) {
		const end = nextLineEnd(text, cursor);
		if (isFenceCloser(text.slice(cursor, end), opener)) return end;
		cursor = end;
	}
	return text.length;
}

function findCodeSpanEnd(text: string, start: number): number | null {
	let openerEnd = start;
	while (text[openerEnd] === "`") openerEnd += 1;
	const length = openerEnd - start;
	let cursor = openerEnd;
	while (cursor < text.length) {
		if (text[cursor] !== "`") {
			cursor += 1;
			continue;
		}
		let end = cursor;
		while (text[end] === "`") end += 1;
		if (end - cursor === length) return end;
		cursor = end;
	}
	return null;
}

function isEscaped(text: string, index: number): boolean {
	let slashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
	return slashes % 2 === 1;
}

function validInlineDollarOpen(text: string, index: number): boolean {
	const next = text[index + 1];
	return text[index] === "$" && text[index - 1] !== "$" && next !== "$" &&
		next !== undefined && !/\s/.test(next) && !isEscaped(text, index);
}

interface InlineDollarSearch {
	start: number | null;
	end: number | null;
	failedOpeners: number[];
}

function findInlineDollarPair(text: string, start: number): InlineDollarSearch {
	const lineEnd = text.indexOf("\n", start + 1);
	const limit = lineEnd === -1 ? text.length : lineEnd;
	let opening = start;
	const failedOpeners: number[] = [];
	for (let i = start + 1; i < limit; i += 1) {
		if (text[i] !== "$" || text[i + 1] === "$" || isEscaped(text, i)) continue;
		const previous = text[i - 1];
		const next = text[i + 1];
		if (previous && !/\s/.test(previous) && (next === undefined || !/\d/.test(next))) {
			return { start: opening, end: i + 1, failedOpeners };
		}
		// An opening delimiter cannot contain another opening delimiter. Abandon
		// it and keep the newer candidate. This both recovers `$broken $x$` and
		// ensures a line full of unmatched dollars is scanned only once.
		if (validInlineDollarOpen(text, i)) {
			failedOpeners.push(opening);
			opening = i;
		}
	}
	failedOpeners.push(opening);
	return { start: null, end: null, failedOpeners };
}

function findDisplayDollarEnd(text: string, start: number): number | null {
	for (let i = start + 2; i < text.length - 1; i += 1) {
		if (text.startsWith("$$", i) && !isEscaped(text, i)) {
			return i === start + 2 ? null : i + 2;
		}
	}
	return null;
}

function findEscapedMathEnd(text: string, start: number, closing: ")" | "]", multiline: boolean): number | null {
	for (let i = start + 2; i < text.length - 1; i += 1) {
		if (!multiline && text[i] === "\n") return null;
		if (text[i] === "\\" && text[i + 1] === closing && !isEscaped(text, i)) {
			return i === start + 2 ? null : i + 2;
		}
	}
	return null;
}

function scanSegments(text: string): Segment[] {
	const segments: Segment[] = [];
	const failedDollarOpeners = new Set<number>();
	let textStart = 0;
	let cursor = 0;
	const flushText = (end: number) => {
		if (end > textStart) segments.push({ kind: "text", raw: text.slice(textStart, end) });
	};
	while (cursor < text.length) {
		if (cursor === 0 || text[cursor - 1] === "\n") {
			const lineEnd = nextLineEnd(text, cursor);
			const opener = parseFenceOpener(text.slice(cursor, lineEnd));
			if (opener) {
				flushText(cursor);
				const end = findFenceEnd(text, lineEnd, opener);
				segments.push({ kind: "fencedCode", raw: text.slice(cursor, end) });
				cursor = end;
				textStart = cursor;
				continue;
			}
		}
		if (text[cursor] === "`") {
			const end = findCodeSpanEnd(text, cursor);
			if (end !== null) {
				flushText(cursor);
				segments.push({ kind: "inlineCode", raw: text.slice(cursor, end) });
				cursor = end;
				textStart = cursor;
				continue;
			}
		}
		if (text.startsWith("$$", cursor) && !isEscaped(text, cursor)) {
			const end = findDisplayDollarEnd(text, cursor);
			if (end !== null) {
				flushText(cursor);
				segments.push({ kind: "displayMath", raw: text.slice(cursor, end), content: text.slice(cursor + 2, end - 2) });
				cursor = end;
				textStart = cursor;
				continue;
			}
		}
		if (text.startsWith("\\[", cursor) && !isEscaped(text, cursor)) {
			const end = findEscapedMathEnd(text, cursor, "]", true);
			if (end !== null) {
				flushText(cursor);
				segments.push({ kind: "displayMath", raw: text.slice(cursor, end), content: text.slice(cursor + 2, end - 2) });
				cursor = end;
				textStart = cursor;
				continue;
			}
		}
		if (text.startsWith("\\(", cursor) && !isEscaped(text, cursor)) {
			const end = findEscapedMathEnd(text, cursor, ")", false);
			if (end !== null) {
				flushText(cursor);
				segments.push({ kind: "inlineMath", raw: text.slice(cursor, end), content: text.slice(cursor + 2, end - 2) });
				cursor = end;
				textStart = cursor;
				continue;
			}
		}
		if (!failedDollarOpeners.has(cursor) && validInlineDollarOpen(text, cursor)) {
			const pair = findInlineDollarPair(text, cursor);
			for (const failed of pair.failedOpeners) failedDollarOpeners.add(failed);
			if (pair.start !== null && pair.end !== null) {
				flushText(pair.start);
				segments.push({
					kind: "inlineMath",
					raw: text.slice(pair.start, pair.end),
					content: text.slice(pair.start + 1, pair.end - 1),
				});
				cursor = pair.end;
				textStart = cursor;
				continue;
			}
		}
		cursor += 1;
	}
	flushText(text.length);
	return segments;
}

function convertBareCommands(text: string): string {
	let result = "";
	let cursor = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] !== "\\" || isEscaped(text, i)) continue;
		const command = readCommand(text, i);
		const converted = commandMap[command.name] ?? namedFunctions[command.name];
		if (converted === undefined) continue;
		result += text.slice(cursor, i) + converted;
		cursor = command.end;
		i = command.end - 1;
	}
	return cursor === 0 ? text : result + text.slice(cursor);
}

function isMath(segment: Segment): boolean {
	return segment.kind === "inlineMath" || segment.kind === "displayMath";
}

export interface LatexUnicodeConversion {
	text: string;
	changed: boolean;
}

/** Convert delimited LaTeX math and report whether the result differs. */
export function convertLatexToUnicode(text: string): LatexUnicodeConversion {
	if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) {
		return { text, changed: false };
	}
	const segments = scanSegments(text);
	if (!segments.some(isMath)) return { text, changed: false };
	const converted = segments.map((segment) => {
		if (isMath(segment)) return convertMathExpr(segment.content ?? "");
		if (segment.kind === "text") return convertBareCommands(segment.raw);
		return segment.raw;
	}).join("");
	return { text: converted, changed: converted !== text };
}
