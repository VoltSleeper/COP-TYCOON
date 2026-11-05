const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.notEqual(a, -1, "Missing source marker: " + start);
  assert.notEqual(b, -1, "Missing source end marker: " + end);
  return html.slice(a, b);
}

// Parse every inline JavaScript block to catch syntax errors before deployment.
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1]) && !/application\/(?:ld\+json|json)/i.test(match[1]))
  .map(match => match[2].trim())
  .filter(Boolean);
assert.ok(inlineScripts.length > 0, "Expected inline JavaScript in index.html");
inlineScripts.forEach((script, index) => new vm.Script(script, { filename: "index.html:inline-" + index }));

// Run the actual production parser with a small deterministic fixture roster.
const parserSource = [
  between("    function normalizeSimText(value){", "    function simContains("),
  between("    function simContains(text,term){", "    function parseNumericToken("),
  between("    function parseNumericToken(value){", "    function parseMoney(value){"),
  between("    function parseMoney(value){", "    function parsePercentageFromText("),
  between("    function parsePercentageFromText(value){", "    function parseMoneyFromText("),
  between("    function parseMoneyFromText(value){", "    const SIM_ACTIONS = ["),
  between("    const SIM_ACTIONS = [", "\n    ];"),
  between("    function parseSimulationInput(text){", "    function simArrow("),
  "\nthis.parseSimulationInput = parseSimulationInput;"
].join("\n");

const roster = [
  { es: "España", en: "Spain", fr: "Espagne", flag: "🇪🇸" },
  { es: "Francia", en: "France", fr: "France", flag: "🇫🇷" },
  { es: "Tuvalu", en: "Tuvalu", fr: "Tuvalu", flag: "🇹🇻" },
  { es: "China", en: "China", fr: "Chine", flag: "🇨🇳" },
  { es: "Ucrania", en: "Ukraine", fr: "Ukraine", flag: "🇺🇦" }
];
const stakeholders = [
  { es: "Lobby Nestlé", en: "Lobby Nestlé", fr: "Lobby Nestlé", aliases: ["Nestlé", "Nestle"], icon: "🏢" }
];
const context = { countryRoster: roster, stakeholderRoster: stakeholders, console };
vm.createContext(context);
vm.runInContext(parserSource, context);
const parse = context.parseSimulationInput;

{
  const result = parse("España dona a Tuvalu y Nestlé contra la subida del mar");
  assert.equal(result.action?.key, "donation", "Explicit transfer should outrank incidental sea-level wording");
  assert.equal(result.explicitTransfer, true);
  assert.equal(result.receiverStartIndex, 1);
  assert.deepEqual(Array.from(result.participants, p => p.es), ["España", "Tuvalu", "Lobby Nestlé"]);
}
{
  const result = parse("Francia invierte 100M en renovables para España");
  assert.equal(result.action?.key, "renewables");
  assert.equal(result.explicitTransfer, true, "'para' must mark the recipient relation");
  assert.equal(result.receiverStartIndex, 1);
  assert.equal(result.amount, 100000000);
}
{
  const result = parse("España combate la subida del mar");
  assert.equal(result.action?.key, "sea_level");
  assert.equal(result.participants.length, 1);
  assert.equal(result.action.self, true);
  assert.equal(result.mitigation, true);
}
{
  const result = parse("China bombardea Ucrania");
  assert.equal(result.explicitTransfer, false);
  assert.equal(result.receiverStartIndex, -1, "A second participant must not become an inferred recipient");
}

assert.match(html, /function acknowledgeGeneralScenario\(/, "General questions need a non-transaction outcome");
assert.match(html, /generalAnswer/, "A general-scenario clarification must not be parsed as a transaction");
assert.match(html, /pendingThinkRecover\.original/, "The original phrase must be retained during clarification");
assert.match(html, /return \{text:String\(input\|\|""\),replacements:\[\]\};/, "Autocorrection must not silently rewrite user intent");
assert.doesNotMatch(html, /participants\.length>1\?participants\.length-1:-1/, "No last-participant recipient fallback");
console.log("Think & Recover regression checks passed.");
