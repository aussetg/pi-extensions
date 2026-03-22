/**
 * LaTeX-to-Unicode converter optimized for PragmataPro Semiotics font.
 *
 * Handles: Greek, operators, relations, arrows, superscripts, subscripts,
 * font variants (bb, cal, bf, it, rm, frak, sf, tt), fractions, roots,
 * delimiters, and common text-mode LaTeX in markdown/code blocks.
 */

// ---------------------------------------------------------------------------
// Greek letters
// ---------------------------------------------------------------------------
const greekLower: Record<string, string> = {
	alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
	varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
	iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν",
	xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ",
	sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ",
	varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
};

const greekUpper: Record<string, string> = {
	Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
	Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

// ---------------------------------------------------------------------------
// Mathematical operators
// ---------------------------------------------------------------------------
const operators: Record<string, string> = {
	sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭",
	oint: "∮", bigcup: "⋃", bigcap: "⋂", bigotimes: "⨂", bigoplus: "⨁",
	bigodot: "⨀", bigvee: "⋁", bigwedge: "⋀", wedge: "∧", vee: "∨",
	cap: "∩", cup: "∪", setminus: "∖", cdot: "·", ast: "∗", star: "⋆",
	circ: "∘", bullet: "∙", diamond: "⋄", times: "×", div: "÷",
	pm: "±", mp: "∓", plusmn: "±", minus: "−", Triangleleft: "◁",
	Triangleright: "▷", triangle: "△", Box: "□", square: "□",
	oplus: "⊕", ominus: "⊖", otimes: "⊗", oslash: "⊘", odot: "⊙",
	dagger: "†", ddagger: "‡", lhd: "⊲", rhd: "⊳",
	unlhd: "⊴", unrhd: "⊵",
	wr: "≀", amalg: "∐",
	uplus: "⊎", sqcap: "⊓", sqcup: "⊔",
};

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
const relations: Record<string, string> = {
	eq: "=", neq: "≠", ne: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥",
	approx: "≈", sim: "∼", simeq: "≃", cong: "≅", equiv: "≡",
	propto: "∝", parallel: "∥", perp: "⊥", mid: "∣", nmid: "∤",
	precsim: "≾", succsim: "≿", prec: "≺", succ: "≻", preceq: "⪯",
	succeq: "⪰", ll: "≪", gg: "≫", subset: "⊂", supset: "⊃",
	subseteq: "⊆", supseteq: "⊇", sqsubset: "⊏", sqsupset: "⊐",
	sqsubseteq: "⊑", sqsupseteq: "⊒", nsim: "≁", ncong: "≇",
	doteq: "≐", llless: "⋘", gggtr: "⋙",
};

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------
const arrows: Record<string, string> = {
	leftarrow: "←", gets: "←", Leftarrow: "⇐",
	rightarrow: "→", to: "→", Rightarrow: "⇒",
	leftrightarrow: "↔", Leftrightarrow: "⇔",
	uparrow: "↑", Uparrow: "⇑",
	downarrow: "↓", Downarrow: "⇓",
	updownarrow: "↕", Updownarrow: "⇕",
	nwarrow: "↖", nearrow: "↗", searrow: "↘", swarrow: "↙",
	mapsto: "↦", longmapsto: "⟼",
	hookleftarrow: "↩", hookrightarrow: "↪",
	rightleftharpoons: "⇌", leftrightharpoons: "⇌",
	longleftarrow: "⟵", Longleftarrow: "⟸",
	longrightarrow: "⟶", Longrightarrow: "⟹",
	longleftrightarrow: "⟷", Longleftrightarrow: "⟺",
	rightharpoonup: "⇀", rightharpoondown: "⇁",
	leftharpoonup: "↼", leftharpoondown: "↽",
	nearrow: "↗", searrow: "↘",
	dashrightarrow: "⇥", dashleftarrow: "⇤",
Rightsquigarrow: "⇝", leftsquigarrow: "⇜",
};

// ---------------------------------------------------------------------------
// Big operators / named functions
// ---------------------------------------------------------------------------
const namedFuncs: Record<string, string> = {
	sin: "sin", cos: "cos", tan: "tan", cot: "cot",
	sec: "sec", csc: "csc", arcsin: "arcsin", arccos: "arccos",
	arctan: "arctan", sinh: "sinh", cosh: "cosh", tanh: "tanh",
	log: "log", ln: "ln", exp: "exp", lim: "lim",
	limsup: "lim sup", liminf: "lim inf",
	max: "max", min: "min", sup: "sup", inf: "inf",
	det: "det", dim: "dim", ker: "ker", hom: "hom",
	Pr: "Pr", deg: "deg", gcd: "gcd", arg: "arg",
	Im: "ℑ", Re: "ℜ",
	clr: "clr", mod: "mod",
};

// ---------------------------------------------------------------------------
// Standalone symbols (not slash-command, but recognizable)
// ---------------------------------------------------------------------------
const symbols: Record<string, string> = {
	infty: "∞", infinity: "∞", partial: "∂", nabla: "∇",
 forall: "∀", exists: "∃", nexists: "∄", emptyset: "∅",
	varnothing: "∅", complement: "∁", aleph: "ℵ", beth: "ℶ",
	ell: "ℓ", wp: "℘", Re: "ℜ", Im: "ℑ",
	angledouble: "⟨", langle: "⟨", rangle: "⟩",
	lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
	lbrack: "[", rbrack: "]", lbrace: "{", rbrace: "}",
	vert: "|", Vert: "‖", backslash: "∕",
	lVert: "‖", rVert: "‖", lvert: "|", rvert: "|",
	surd: "√", checkmark: "✓", dagger: "†", ddagger: "‡",
	top: "⊤", bot: "⊥", models: "⊨", forces: "⊜",
	vdash: "⊢", Vdash: "⊢", therefore: "∴", because: "∵",
	ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
	quad: "  ", qquad: "    ",
	enspace: " ", thinspace: " ", negthinspace: "!", 
	nobreakspace: " ", space: " ",
	nabla: "∇", hbar: "ℏ",
	neg: "¬", flat: "♭", natural: "♮", sharp: "♯",
	primes: "″",
	imath: "ı", jmath: "ȷ",
	colon: "∶", percentage: "%",
	slash: "/", smile: "⌣", frown: "⌢",
};

// ---------------------------------------------------------------------------
// Superscript and subscript characters
// ---------------------------------------------------------------------------
const superscripts: Record<string, string> = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
	"5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
	"+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
	"n": "ⁿ", "i": "ⁱ", "j": "ʲ",
};

const subscripts: Record<string, string> = {
	"0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
	"5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
	"+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
	"a": "ₐ", "e": "ₑ", "h": "ₕ", "i": "ᵢ", "j": "ⱼ",
	"k": "ₖ", "l": "ₗ", "m": "ₘ", "n": "ₙ", "o": "ₒ",
	"p": "ₚ", "r": "ᵣ", "s": "ₛ", "t": "ₜ", "u": "ᵤ",
	"v": "ᵥ", "x": "ₓ",
};

// ---------------------------------------------------------------------------
// Mathbb (double-struck) – U+1D538..U+1D550 (bold), common ones
// ---------------------------------------------------------------------------
const mathbb: Record<string, string> = {
	R: "ℝ", Z: "ℤ", N: "ℕ", Q: "ℚ", C: "ℂ",
	P: "ℙ", H: "ℍ", F: "𝔽", K: "𝕂", E: "𝔼",
	G: "𝔾", A: "𝔸", B: "𝔹", D: "𝔻", I: "𝕀",
	L: "𝕃", M: "𝕄", O: "𝕆", S: "𝕊", T: "𝕋",
	W: "𝕎", X: "𝕏", Y: "𝕐",
	"0": "𝟘", "1": "𝟙", "2": "𝟚", "3": "𝟛", "4": "𝟜",
	"5": "𝟝", "6": "𝟞", "7": "𝟟", "8": "𝟠", "9": "𝟡",
};

// ---------------------------------------------------------------------------
// Mathcal (calligraphic) – U+1D49C..U+1D4B5
// ---------------------------------------------------------------------------
const mathcal: Record<string, string> = {
	A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ",
	G: "𝒢", H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ",
	M: "ℳ", N: "𝒩", O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ",
	S: "𝒮", T: "𝒯", U: "𝒰", V: "𝒱", W: "𝒲", X: "𝒳",
	Y: "𝒴", Z: "ℨ",
};

// ---------------------------------------------------------------------------
// Mathfrak (Fraktur) – U+1D504..U+1D537
// ---------------------------------------------------------------------------
const mathfrakEntries: [string, number][] = [
	["A", 0x1D504], ["B", 0x1D505], ["C", 0x1D507], ["D", 0x1D508],
	["E", 0x1D509], ["F", 0x1D50A], ["G", 0x1D50D], ["H", 0x1D50E],
	["I", 0x1D50F], ["J", 0x1D510], ["K", 0x1D511], ["L", 0x1D512],
	["M", 0x1D513], ["N", 0x1D514], ["O", 0x1D515], ["P", 0x1D516],
	["Q", 0x1D517], ["R", 0x1D518], ["S", 0x1D519], ["T", 0x1D51A],
	["U", 0x1D51B], ["V", 0x1D51C], ["W", 0x1D51D], ["X", 0x1D51E],
	["Y", 0x1D51F], ["Z", 0x1D520],
	// Lowercase: U+1D51E..U+1D537
	["a", 0x1D51E], ["b", 0x1D51F], ["c", 0x1D520], ["d", 0x1D521],
	["e", 0x1D522], ["f", 0x1D523], ["g", 0x1D524], ["h", 0x1D525],
	["i", 0x1D526], ["j", 0x1D527], ["k", 0x1D528], ["l", 0x1D529],
	["m", 0x1D52A], ["n", 0x1D52B], ["o", 0x1D52C], ["p", 0x1D52D],
	["q", 0x1D52E], ["r", 0x1D52F], ["s", 0x1D530], ["t", 0x1D531],
	["u", 0x1D532], ["v", 0x1D533], ["w", 0x1D534], ["x", 0x1D535],
	["y", 0x1D536], ["z", 0x1D537],
];
const mathfrak: Record<string, string> = Object.fromEntries(
	mathfrakEntries.map(([ch, cp]) => [ch, String.fromCodePoint(cp)])
);

// ---------------------------------------------------------------------------
// Mathscr (script) – U+1D4B6..U+1D4CF
// ---------------------------------------------------------------------------
const mathscr: Record<string, string> = {
	A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ",
	G: "𝒢", H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ",
	M: "ℳ", N: "𝒩", O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ",
	S: "𝒮", T: "𝒯", U: "𝒰", V: "𝒱", W: "𝒲", X: "𝒳",
	Y: "𝒴", Z: "ℨ",
};

// ---------------------------------------------------------------------------
// Bold math letters – U+1D400..U+1D41A (A-Z), U+1D41A..U+1D433 (a-z)
// ---------------------------------------------------------------------------
const mathbold = (c: string): string | undefined => {
	const base = c.toUpperCase();
	const isUpper = c === base;
	const offset = isUpper ? 0x1D400 : 0x1D41A;
	const idx = base.charCodeAt(0) - 65;
	if (idx < 0 || idx > 25) return undefined;
	return String.fromCodePoint(offset + idx);
};

// ---------------------------------------------------------------------------
// Italic math letters – U+1D434..U+1D44D (A-Z), U+1D44E..U+1D467 (a-z)
// ---------------------------------------------------------------------------
const mathitalic = (c: string): string | undefined => {
	const base = c.toUpperCase();
	const isUpper = c === base;
	const offset = isUpper ? 0x1D434 : 0x1D44E;
	const idx = base.charCodeAt(0) - 65;
	if (idx < 0 || idx > 25) return undefined;
	return String.fromCodePoint(offset + idx);
};

// ---------------------------------------------------------------------------
// Monospace math – U+1D670..U+1D689 (A-Z), U+1D68A..U+1D6A3 (a-z)
// ---------------------------------------------------------------------------
const mathtt = (c: string): string | undefined => {
	const base = c.toUpperCase();
	const isUpper = c === base;
	const offset = isUpper ? 0x1D670 : 0x1D68A;
	const idx = base.charCodeAt(0) - 65;
	if (idx < 0 || idx > 25) return undefined;
	return String.fromCodePoint(offset + idx);
};

// ---------------------------------------------------------------------------
// Sans-serif math – U+1D5A0..U+1D5B9 (A-Z), U+1D5BA..U+1D5D3 (a-z)
// ---------------------------------------------------------------------------
const mathsf = (c: string): string | undefined => {
	const base = c.toUpperCase();
	const isUpper = c === base;
	const offset = isUpper ? 0x1D5A0 : 0x1D5BA;
	const idx = base.charCodeAt(0) - 65;
	if (idx < 0 || idx > 25) return undefined;
	return String.fromCodePoint(offset + idx);
};

// ---------------------------------------------------------------------------
// Bold italic – U+1D468..U+1D481 (A-Z), U+1D482..U+1D49B (a-z)
// ---------------------------------------------------------------------------
const mathbfit = (c: string): string | undefined => {
	const base = c.toUpperCase();
	const isUpper = c === base;
	const offset = isUpper ? 0x1D468 : 0x1D482;
	const idx = base.charCodeAt(0) - 65;
	if (idx < 0 || idx > 25) return undefined;
	return String.fromCodePoint(offset + idx);
};

// ---------------------------------------------------------------------------
// All slash-commands → Unicode, merged lookup (longest match first)
// ---------------------------------------------------------------------------
const commandMap: Record<string, string> = {
	...greekLower, ...greekUpper, ...operators, ...relations, ...arrows,
	...symbols,
};

// Commands that take a single brace argument like \mathbb{X}
type FontCmd = (arg: string) => string | undefined;
const fontCommands: Record<string, FontCmd> = {
	mathbb: (a) => mathbb[a],
	mathcal: (a) => mathcal[a],
	cal: (a) => mathcal[a],
	mathfrak: (a) => mathfrak[a],
	frak: (a) => mathfrak[a],
	mathscr: (a) => mathscr[a],
	scr: (a) => mathscr[a],
	mathbf: (a) => mathbold(a),
	bf: (a) => mathbold(a),
	boldsymbol: (a) => mathbold(a),
	mathit: (a) => mathitalic(a),
	mathrm: (a) => a, // roman = just the character
	mathtt: (a) => mathtt(a),
	tt: (a) => mathtt(a),
	mathsf: (a) => mathsf(a),
	sf: (a) => mathsf(a),
	mathbfit: (a) => mathbfit(a),
	bfit: (a) => mathbfit(a),
	text: (a) => a,
	textbf: (a) => a, // can't easily bold in plain text
	textit: (a) => a,
	texttt: (a) => a,
	mathsf: (a) => mathsf(a),
	mathrm: (a) => a,
	hat: (a) => a + "\u0302",      // combining circumflex
	bar: (a) => a + "\u0304",      // combining macron
	vec: (a) => a + "\u20D7",      // combining right arrow above
	tilde: (a) => a + "\u0303",    // combining tilde
	dot: (a) => a + "\u0307",      // combining dot above
	ddot: (a) => a + "\u0308",     // combining diaeresis
	overline: (a) => a + "\u0305", // combining overline
	overbrace: (a) => "⏞" + a + "⏟",
	underbrace: (a) => "⏟" + a + "⏞",
	overleftarrow: (a) => a + "⃖",
	overrightarrow: (a) => a + "⃗",
	underline: (a) => a + "\u0332",
	widehat: (a) => a + "\u0302",
	widetilde: (a) => a + "\u0303",
	obsolete: (a) => a,
	not: (a) => {
		const neg = negations[a];
		return neg || (a + "\u0338"); // combining long solidus overlay
	},
};

const negations: Record<string, string> = {
	"=": "≠", "<": "≱", ">": "≯", "≤": "≨", "≥": "≱",
	"∈": "∉", "∋": "∌", "⊂": "⊄", "⊃": "⊅", "∥": "∦",
	"∼": "≁", "≈": "≉", "≡": "≢", "∝": "∝̸", "∠": "∡",
	"∨": "∤", "∧": "≯",
};

// ---------------------------------------------------------------------------
// Helper: parse a brace group starting at position i in str
// Returns { content: string, end: number } where end is position after '}'
// ---------------------------------------------------------------------------
function parseBraceGroup(str: string, i: number): { content: string; end: number } | null {
	if (str[i] !== "{") return null;
	let depth = 1;
	let j = i + 1;
	while (j < str.length && depth > 0) {
		if (str[j] === "{") depth++;
		else if (str[j] === "}") depth--;
		j++;
	}
	if (depth !== 0) return null;
	return { content: str.slice(i + 1, j - 1), end: j };
}

// ---------------------------------------------------------------------------
// Convert a single math expression string to Unicode
// ---------------------------------------------------------------------------
function convertMathExpr(expr: string): string {
	let result = "";
	let i = 0;

	while (i < expr.length) {
		const ch = expr[i];

		// Backslash command
		if (ch === "\\") {
			i++;
			// Read command name
			let cmd = "";
			while (i < expr.length && /[a-zA-Z]/.test(expr[i])) {
				cmd += expr[i];
				i++;
			}

			// Escaped special chars
			if (cmd === "") {
				const next = expr[i];
				if (next === "\\") { result += "\\"; i++; continue; }
				if (next === "$") { result += "$"; i++; continue; }
				if (next === "#") { result += "#"; i++; continue; }
				if (next === "%") { result += "%"; i++; continue; }
				if (next === "&") { result += "&"; i++; continue; }
				if (next === "_") { result += "_"; i++; continue; }
				if (next === "{") { result += "{"; i++; continue; }
				if (next === "}") { result += "}"; i++; continue; }
				if (next === "~") { result += "\u202F"; i++; continue; }  // narrow no-break space
				if (next === " ") { result += " "; i++; continue; }
				if (next === "|") { result += "‖"; i++; continue; }
				if (next === ",") { result += "\u2009"; i++; continue; }  // \, thin space
				if (next === ";") { result += "\u2005"; i++; continue; } // \; medium space
				if (next === ":") { result += "\u2004"; i++; continue; }  // \: medium-math space
				if (next === "!") { result += "\u2006"; i++; continue; }   // \! negative thin space
				// unknown escaped char, keep as-is
				result += "\\"; continue;
			}

			// Named functions (render as upright text)
			if (cmd in namedFuncs) {
				result += namedFuncs[cmd]!;
				// In Unicode rendering, keep the space (LaTeX consumes it)
				// Don't skip space after
				continue;
			}

			// Font commands \mathbb{X}, \mathcal{X}, etc.
			if (cmd in fontCommands) {
				// Skip optional whitespace
				while (i < expr.length && (expr[i] === " " || expr[i] === "\t")) i++;
				const group = parseBraceGroup(expr, i);
				if (group) {
					let converted = fontCommands[cmd]!(group.content);
					// If single-arg lookup failed, try character-by-character
					if (converted === undefined) {
						const perChar = [...group.content].map(c => fontCommands[cmd]!(c)).filter(Boolean).join("");
						if (perChar.length > 0) converted = perChar;
					}
					result += converted ?? `\\${cmd}{${group.content}}`;
					i = group.end;
					continue;
				}
				// Single char without braces: \mathbb R
				if (i < expr.length && /[a-zA-Z0-9]/.test(expr[i])) {
					const converted = fontCommands[cmd]!(expr[i]);
					result += converted ?? `\\${cmd}${expr[i]}`;
					i++;
					continue;
				}
				result += `\\${cmd}`;
				continue;
			}

			// \frac{num}{den}
			if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
				while (i < expr.length && expr[i] === " ") i++;
				const numGroup = parseBraceGroup(expr, i);
				if (numGroup) {
					i = numGroup.end;
					while (i < expr.length && expr[i] === " ") i++;
					const denGroup = parseBraceGroup(expr, i);
					if (denGroup) {
						i = denGroup.end;
						const num = convertMathExpr(numGroup.content).trim();
						const den = convertMathExpr(denGroup.content).trim();
						// Add parens if numerator or denominator has operators
						const numParens = /[+\-*/^=≠≤≥<>∈∉⊂⊃∩∪ ]/.test(num) && num.length > 1;
						const denParens = /[+\-*/^=≠≤≥<>∈∉⊂⊃∩∪ ]/.test(den) && den.length > 1;
						result += `${numParens ? `(${num})` : num}/${denParens ? `(${den})` : den}`;
						continue;
					}
				}
				result += "/";
				continue;
			}

			// \sqrt[n]{x} and \sqrt{x}
			if (cmd === "sqrt") {
				while (i < expr.length && expr[i] === " ") i++;
				let nthRoot = "";
				// Check for optional [n]
				if (i < expr.length && expr[i] === "[") {
					let j = i + 1;
					while (j < expr.length && expr[j] !== "]") j++;
					nthRoot = expr.slice(i + 1, j);
					i = j + 1;
					while (i < expr.length && expr[i] === " ") i++;
				}
				const group = parseBraceGroup(expr, i);
				if (group) {
					i = group.end;
					const inner = convertMathExpr(group.content).trim();
					const needParens = inner.length > 1;
					if (nthRoot) {
						result += `√[${convertMathExpr(nthRoot)}]${needParens ? `(${inner})` : inner}`;
					} else {
						result += `√${needParens ? `(${inner})` : inner}`;
					}
					continue;
				}
				// Single char without braces
				if (i < expr.length && expr[i] !== " " && expr[i] !== "}" && expr[i] !== "\\") {
					result += `√${expr[i]}`;
					i++;
					continue;
				}
				result += "√";
				continue;
			}

			// \overset{x}{y}, \underset{x}{y}
			if (cmd === "overset" || cmd === "underset") {
				while (i < expr.length && expr[i] === " ") i++;
				const top = parseBraceGroup(expr, i);
				if (top) {
					i = top.end;
					while (i < expr.length && expr[i] === " ") i++;
					const bot = parseBraceGroup(expr, i);
					if (bot) {
						i = bot.end;
						result += `${convertMathExpr(bot.content)}${cmd === "overset" ? "^" : "_"}(${convertMathExpr(top.content)})`;
						continue;
					}
				}
				continue;
			}

			// \binom{n}{k}, \tbinom{n}{k}
			if (cmd === "binom" || cmd === "tbinom") {
				while (i < expr.length && expr[i] === " ") i++;
				const n = parseBraceGroup(expr, i);
				if (n) {
					i = n.end;
					while (i < expr.length && expr[i] === " ") i++;
					const k = parseBraceGroup(expr, i);
					if (k) {
						i = k.end;
						result += `C(${convertMathExpr(n.content)},${convertMathExpr(k.content)})`;
						continue;
					}
				}
				continue;
			}

			// \left and \right delimiters
			if (cmd === "left" || cmd === "right") {
				// These are sizing hints; just skip them
				while (i < expr.length && expr[i] === " ") i++;
				if (i < expr.length) {
					const delim = expr[i];
					const delimMap: Record<string, string> = {
						"(": "(", ")": ")", "[": "[", "]": "]",
						"|": "|", ".": "", "\\": "∕",
					};
					if (delim === "\\") {
						let d = "";
						i++;
						while (i < expr.length && /[a-zA-Z]/.test(expr[i])) {
							d += expr[i]; i++;
						}
						result += delimMap[d] ?? `\\${d}`;
					} else {
						result += delimMap[delim] ?? delim;
						i++;
					}
				}
				continue;
			}

			// \begin{env}...\end{env}
			if (cmd === "begin") {
				while (i < expr.length && expr[i] === " ") i++;
				const envGroup = parseBraceGroup(expr, i);
				if (envGroup) {
					i = envGroup.end;
					const envName = envGroup.content;
					// Skip to \end{envName}
					const endMarker = `\\end{${envName}}`;
					const endIdx = expr.indexOf(endMarker, i);
					if (endIdx !== -1) {
						const body = expr.slice(i, endIdx);
						i = endIdx + endMarker.length;
						// Simple environments
						if (envName === "cases" || envName === "aligned" || envName === "align" || envName === "array" || envName === "matrix" || envName === "pmatrix" || envName === "bmatrix" || envName === "vmatrix") {
							const prefix = envName === "pmatrix" ? "(" : envName === "bmatrix" ? "[" : envName === "vmatrix" ? "|" : "";
							const suffix = envName === "pmatrix" ? ")" : envName === "bmatrix" ? "]" : envName === "vmatrix" ? "|" : "";
							// Convert body, replace & with alignment and \\ with newlines
							const converted = convertMathExpr(body)
								.replace(/\\\\\s*/g, "\n")
								.replace(/&/g, "  ");
							result += `${prefix}${converted.trim()}${suffix}`;
						} else if (envName === "cases") {
							const converted = convertMathExpr(body)
								.replace(/\\\\\s*/g, "\n")
								.replace(/&/g, ", ");
							result += `{ ${converted.trim()} }`;
						} else {
							result += convertMathExpr(body);
						}
						continue;
					}
				}
				continue;
			}

			// \text{...}
			if (cmd === "text" || cmd === "textbf" || cmd === "textit" || cmd === "textrm") {
				while (i < expr.length && expr[i] === " ") i++;
				const group = parseBraceGroup(expr, i);
				if (group) {
					result += group.content;
					i = group.end;
					continue;
				}
				continue;
			}

			// \operatorname{...}
			if (cmd === "operatorname") {
				while (i < expr.length && expr[i] === " ") i++;
				const group = parseBraceGroup(expr, i);
				if (group) {
					result += group.content;
					i = group.end;
					continue;
				}
				continue;
			}

			// \color{...}{...} – skip color, render inner
			if (cmd === "color" || cmd === "textcolor" || cmd === "colorbox") {
				while (i < expr.length && expr[i] === " ") i++;
				const colorGroup = parseBraceGroup(expr, i);
				if (colorGroup) {
					i = colorGroup.end;
					while (i < expr.length && expr[i] === " ") i++;
					const bodyGroup = parseBraceGroup(expr, i);
					if (bodyGroup) {
						result += convertMathExpr(bodyGroup.content);
						i = bodyGroup.end;
						continue;
					}
				}
				continue;
			}

			// Big operator with limits: \sum_{i=0}^{n}
			if (cmd === "sum" || cmd === "prod" || cmd === "coprod" || cmd === "int" || cmd === "iint" || cmd === "iiint" || cmd === "oint" || cmd === "bigcup" || cmd === "bigcap" || cmd === "bigoplus" || cmd === "bigotimes" || cmd === "bigodot" || cmd === "bigvee" || cmd === "bigwedge" || cmd === "lim" || cmd === "limsup" || cmd === "liminf") {
				result += commandMap[cmd] ?? cmd;
				// Collect subscript and superscript
				let sub = "";
				let sup = "";
				if (i < expr.length && expr[i] === "_") {
					i++;
					const subGroup = parseBraceGroup(expr, i);
					if (subGroup) { sub = convertMathExpr(subGroup.content); i = subGroup.end; }
					else if (i < expr.length && expr[i] === "\\") {
						// Bare \command: _\infty
						let lcmd = ""; let j = i + 1;
						while (j < expr.length && /[a-zA-Z]/.test(expr[j])) { lcmd += expr[j]; j++; }
						const lsym = commandMap[lcmd] ?? symbols[lcmd];
						if (lsym) { sub = lsym; i = j; }
						else { sub = expr[i]; i++; }
					}
					else if (i < expr.length) { sub = expr[i]; i++; }
				}
				if (i < expr.length && expr[i] === "^") {
					i++;
					const supGroup = parseBraceGroup(expr, i);
					if (supGroup) { sup = convertMathExpr(supGroup.content); i = supGroup.end; }
					else if (i < expr.length && expr[i] === "\\") {
						// Bare \command: ^\infty
						let lcmd = ""; let j = i + 1;
						while (j < expr.length && /[a-zA-Z]/.test(expr[j])) { lcmd += expr[j]; j++; }
						const lsym = commandMap[lcmd] ?? symbols[lcmd];
						if (lsym) { sup = lsym; i = j; }
						else { sup = expr[i]; i++; }
					}
					else if (i < expr.length) { sup = expr[i]; i++; }
				}
				// Use Unicode sub/sup only if ALL chars are convertible
				const useUnicodeSub = sub.length > 0 && sub.length <= 8 && canSubscript(sub);
				const useUnicodeSup = sup.length > 0 && sup.length <= 8 && canSuperscript(sup);
				if (useUnicodeSub) result += toSubscript(sub);
				if (useUnicodeSup) result += toSuperscript(sup);
				// Fallback for whichever one couldn't be Unicode'd
				if (sub && !useUnicodeSub) result += formatSub(sub);
				if (sup && !useUnicodeSup) result += formatSup(sup);
				continue;
			}

			// Standard command lookup
			if (commandMap[cmd]) {
				result += commandMap[cmd]!;
				continue;
			}

			// Unknown command: just output the command name
			result += cmd;
			continue;
		}

		// Superscript ^
		if (ch === "^") {
			i++;
			const group = parseBraceGroup(expr, i);
			if (group) {
				const converted = convertMathExpr(group.content);
				if (canSuperscript(converted) && converted.length <= 8) {
					result += toSuperscript(converted);
				} else {
					result += formatSup(converted);
				}
				i = group.end;
				continue;
			}
			// Single char or \command without braces: ^\infty, ^2
			if (i < expr.length && expr[i] === "\\") {
				// Read the command
				let cmd = "";
				let j = i + 1;
				while (j < expr.length && /[a-zA-Z]/.test(expr[j])) { cmd += expr[j]; j++; }
				const sym = commandMap[cmd] ?? symbols[cmd];
				if (sym) {
					result += superscripts[sym] ?? formatSup(sym);
					i = j;
					continue;
				}
				// Unknown command, fall through
			}
			if (i < expr.length) {
				const c = expr[i];
				result += superscripts[c] ?? formatSup(c);
				i++;
				continue;
			}
			continue;
		}

		// Subscript _
		if (ch === "_") {
			i++;
			const group = parseBraceGroup(expr, i);
			if (group) {
				const converted = convertMathExpr(group.content);
				if (canSubscript(converted) && converted.length <= 8) {
					result += toSubscript(converted);
				} else {
					result += formatSub(converted);
				}
				i = group.end;
				continue;
			}
			// Single char or \command without braces: _\infty, _2
			if (i < expr.length && expr[i] === "\\") {
				let cmd = "";
				let j = i + 1;
				while (j < expr.length && /[a-zA-Z]/.test(expr[j])) { cmd += expr[j]; j++; }
				const sym = commandMap[cmd] ?? symbols[cmd];
				if (sym) {
					result += subscripts[sym] ?? formatSub(sym);
					i = j;
					continue;
				}
			}
			if (i < expr.length) {
				const c = expr[i];
				result += subscripts[c] ?? formatSub(c);
				i++;
				continue;
			}
			continue;
		}

		// Prime (apostrophe used as derivative)
		if (ch === "'") {
			result += "′";
			i++;
			continue;
		}

		// Regular character
		result += ch;
		i++;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Formatting helpers for superscript/subscript fallback
// ---------------------------------------------------------------------------

/** Return `^(content)` or `^content` — parens for multi-char content to avoid
 *  ambiguous readings like _-∞ where a subscriptable sign mixes with a
 *  non-subscriptable symbol. Single chars are always unambiguous. */
function formatSup(content: string): string {
	return content.length <= 1 ? `^${content}` : `^(${content})`;
}

/** Return `_(content)` or `_content`. */
function formatSub(content: string): string {
	return content.length <= 1 ? `_${content}` : `_(${content})`;
}

// ---------------------------------------------------------------------------
// Convert string to superscript characters
// ---------------------------------------------------------------------------
/** Check if all chars in s have a Unicode superscript form. */
function canSuperscript(s: string): boolean {
	return [...s].every(c => superscripts[c] !== undefined);
}

/** Check if all chars in s have a Unicode subscript form. */
function canSubscript(s: string): boolean {
	return [...s].every(c => subscripts[c] !== undefined);
}

function toSuperscript(s: string): string {
	return [...s].map(c => superscripts[c] ?? c).join("");
}

function toSubscript(s: string): string {
	return [...s].map(c => subscripts[c] ?? c).join("");
}

// ---------------------------------------------------------------------------
// Detect LaTeX math in text and convert to Unicode.
// Handles: $...$, $$...$$, \(...\), \[...\]
// Also handles bare \frac, \sqrt, \sum, etc. outside of math delimiters
// when they appear inline in markdown text (common in LLM output).
// ---------------------------------------------------------------------------
const MATH_DELIMITERS = [
	// Display math: $$...$$
	{ open: /\$\$(.+?)\$\$/gs, type: "display" as const },
	// Inline math: $...$  (but not $$)
	{ open: /(?<!\$)\$(?!\$)((?:[^\$\\]|\\.)+?)\$(?!\$)/g, type: "inline" as const },
	// \( ... \)
	{ open: /\\\((.+?)\\\)/gs, type: "inline" as const },
	// \[ ... \]
	{ open: /\\\[(.+?)\\\]/gs, type: "display" as const },
];

/**
 * Check if a string contains LaTeX math
 */
export function hasLatex(text: string): boolean {
	return MATH_DELIMITERS.some(d => d.open.test(text));
}

/**
 * Convert all LaTeX math in text to Unicode equivalents.
 * Returns the converted string.
 */
export function latexToUnicode(text: string): string {
	let result = text;

	for (const delim of MATH_DELIMITERS) {
		result = result.replace(delim.open, (_match, expr: string) => {
			const converted = convertMathExpr(expr).trim();
			return converted;
		});
	}

	// Also handle bare LaTeX commands outside math delimiters
	// that commonly appear in LLM prose (e.g. "use α = β + γ")
	result = result.replace(/\\([a-zA-Z]+)/g, (match, cmd: string) => {
		if (commandMap[cmd]) return commandMap[cmd];
		if (namedFuncs[cmd]) return namedFuncs[cmd];
		return match; // keep unknown commands
	});

	return result;
}
