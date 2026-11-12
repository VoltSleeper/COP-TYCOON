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

// Exercise the actual production autocorrect function, not a duplicate test implementation.
const autocorrectSource = [
  between("    function normalizeSimText(value){", "    function simContains("),
  between("    function autoCorrectSimulatorText(input){", "    function recordSimulatorLearning("),
  "this.autoCorrectSimulatorText = autoCorrectSimulatorText;"
].join("\n");
const autocorrectContext = { console };
vm.createContext(autocorrectContext);
vm.runInContext(autocorrectSource, autocorrectContext);
const autocorrect = autocorrectContext.autoCorrectSimulatorText;
{
  const result = autocorrect("España invierte 20M en renobables");
  assert.equal(result.text, "España invierte 20M en renovables");
  assert.deepEqual(Array.from(result.replacements, item => [item.from, item.to]), [["renobables", "renovables"]]);
}
{
  const result = autocorrect("energia solar y fotoboltaica");
  assert.equal(result.text, "energia solar y fotovoltaica");
}
for (const phrase of [
  "España no dona 20M a Tuvalu",
  "España dona 20M a Tuvalu",
  "España quiere donar 20M a Tuvalu",
  "China bombardea Ucrania",
  "Nestlé invierte 20M en renovables",
  "España invierte 1,5B en renovables"
]) {
  assert.equal(autocorrect(phrase).text, phrase, "High-risk meaning, names and amounts must remain untouched: " + phrase);
}
assert.equal(autocorrect("renobables").replacements.length, 1);
assert.equal(autocorrect("renovables").replacements.length, 0, "Correct words must not be rewritten");

// Run the actual production parser with a small deterministic fixture roster.
const parserSource = [
  between("    function normalizeSimText(value){", "    function simContains("),
  between("    function simContains(text,term){", "    function parseNumericToken("),
  between("    function parseNumericToken(value){", "    function parseMoney(value){"),
  between("    function parseMoney(value){", "    function parsePercentageFromText("),
  between("    function parsePercentageFromText(value){", "    function parseMoneyFromText("),
  between("    function parseMoneyFromText(value){", "    const SIM_ACTIONS = ["),
  between("    const SIM_ACTIONS = [", "\n    ];"),
  "\n    ];",
  between("    function parseSimulationInput(text){", "    function simArrow("),
  "\nthis.parseSimulationInput = parseSimulationInput; this.SIM_ACTIONS = SIM_ACTIONS; this.normalizeSimText = normalizeSimText;"
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
  const corrected = autocorrect("España invierte 20M en renobables");
  const result = parse(corrected.text);
  assert.equal(result.action?.key, "renewables", "A corrected climate term must reach the intended production action");
  assert.equal(result.amount, 20000000, "Autocorrection must preserve the original numeric amount");
}

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
  const result = parse("España dona 20M a Tuvalu para energía solar");
  assert.equal(result.action?.key, "donation", "An explicit donation verb should outrank its stated purpose");
  assert.equal(result.amount, 20000000);
  assert.equal(result.receiverStartIndex, 1);
}
{
  const result = parse("España dona 20M a Tuvalu para alimentos");
  assert.equal(result.action?.key, "donation", "Donation intent should outrank the food-related purpose");
  assert.equal(result.amount, 20000000);
}
{
  const result = parse("Francia invierte 1,5B en renovables para España");
  assert.equal(result.action?.key, "renewables");
  assert.equal(result.amount, 1500000000);
}
{
  const result = parse("España invierte 20M en industria limpia");
  assert.equal(result.action?.key, "clean_industry", "Clean industry should not be mislabeled as heavy industry");
}
{
  const result = parse("España invierte 20M en industria pesada");
  assert.equal(result.action?.key, "heavy_industry");
}
{
  const result = parse("España dona 20M a Tuvalu y 5M a Nestlé");
  assert.equal(result.action?.key, "donation");
  assert.equal(result.amountAmbiguous, true, "Multiple explicit amounts must trigger clarification instead of silently taking the first");
}
{
  const result = parse("España dona -20M a Tuvalu");
  assert.equal(result.negativeAmount, true, "Negative amounts must not be normalized into positive transfers");
}
{
  const result = parse("España invierte -5% en renovables");
  assert.equal(result.negativeAmount, true, "Negative percentages must be rejected too");
}
{
  const result = parse("España dona a Tuvalu");
  assert.equal(result.action?.key, "donation");
  assert.equal(result.amount, null, "Missing amounts must remain missing at parser level");
}
{
  const result = parse("España invierte 20M en healthcare");
  assert.equal(result.action?.key, "health", "Healthcare should resolve to health, not medicine");
}
{
  const result = parse("España invierte 20M en drought resilience");
  assert.equal(result.action?.key, "drought_response");
}
{
  const result = parse("España invierte 20M para evitar deforestación");
  assert.equal(result.action?.key, "reforestation");
}
{
  const result = parse("España invierte 20M en deforestation");
  assert.equal(result.action?.key, "deforestation");
}
{
  const result = parse("España combate la subida del mar");
  assert.equal(result.action?.key, "sea_level");
  assert.equal(result.participants.length, 1);
  assert.equal(result.action.self, true);
  assert.equal(result.mitigation, true);
}
{
  const result = parse("España no dona 20M a Tuvalu");
  assert.equal(result.negatedAction, true, "Negated donations must never execute as positive transfers");
}
{
  const result = parse("España quiere donar 20M a Tuvalu");
  assert.equal(result.intentOnly, true, "A stated intention must be clarified before simulation");
}
for (const phrase of [
  "España no quiere donar a Tuvalu",
  "España no dona a Tuvalu",
  "Spain does not donate to Tuvalu",
  "La France ne donne pas à Tuvalu"
]) {
  assert.equal(parse(phrase).negatedAction, true, "Negated action should be detected: " + phrase);
}
assert.equal(parse("La France souhaite aider Tuvalu").intentOnly, true, "French proposals must be clarified as intentions");
assert.equal(parse("La France prévoit investir 20M en énergies renouvelables").intentOnly, true, "Accent-normalized French/Spanish intent vocabulary must be recognized");
{
  const result = parse("España dona 20M a Tuvalu para ayudar con la adaptación climática");
  assert.equal(result.multipleActionSignals, 0, "A purpose verb must not be mistaken for a second coordinated decision");
}
for (const phrase of [
  "Spain donates to Tuvalu and builds solar panels",
  "La France donne à Tuvalu et construit des panneaux solaires"
]) {
  assert.ok(parse(phrase).multipleActionSignals >= 2, "Coordinated actions must be detected: " + phrase);
}
{
  const result = parse("España dona 20M a Tuvalu y construye paneles solares");
  assert.equal(result.multipleActionSignals, 2, "Two action verbs in one sentence must be split into separate decisions");
}
for (const phrase of ["Spain's action is not a donation", "España no es una donación a Tuvalu", "La France ne fait pas de don à Tuvalu"]) {
  assert.equal(parse(phrase).negatedAction, true, "Negated donation nouns must not become positive transfers: " + phrase);
}
{
  const result = parse("España y Francia ayudan conjuntamente a Tuvalu");
  assert.equal(result.jointAction, true, "Joint actor wording must be recognized");
}
{
  const result = parse("China bombardea Ucrania");
  assert.equal(result.explicitTransfer, false);
  assert.equal(result.receiverStartIndex, -1, "A second participant must not become an inferred recipient");
}

const actionKeys = context.SIM_ACTIONS.map(action => action.key);
assert.equal(new Set(actionKeys).size, actionKeys.length, "Every simulator action must have a unique key");
const phraseOwners = new Map();
for (const action of context.SIM_ACTIONS) {
  for (const word of action.words) {
    const normalized = context.normalizeSimText(word);
    if (!phraseOwners.has(normalized)) phraseOwners.set(normalized, new Set());
    phraseOwners.get(normalized).add(action.key);
  }
}
const overlappingPhrases = [...phraseOwners].filter(([, owners]) => owners.size > 1);
assert.equal(overlappingPhrases.length, 0, "Action vocabulary must not assign the same exact phrase to different actions");

assert.match(html, /function acknowledgeGeneralScenario\(/, "General questions need a non-transaction outcome");
assert.match(html, /Todas las cantidades se interpretan en dólares estadounidenses \(USD\)/, "Spanish UI must explain the budget currency");
assert.match(html, /All amounts are interpreted in US dollars \(USD\)/, "English UI must explain the budget currency");
assert.match(html, /Tous les montants sont interprétés en dollars américains \(USD\)/, "French UI must explain the budget currency");
assert.match(html, /const requiresRecipient=\["donation","trade","debt","aidcut","border"\]/, "Transfer-like actions must not silently become self-actions");
assert.match(html, /questionKind==="receiver"/, "Recipient answers must be handled as recipient clarification");
assert.match(html, /const receiverMarker=lang==="fr"/, "Recipient clarification must establish an explicit localized relation");
assert.match(html, /key:"food_block",requiresAmount:false,noBudget:true/, "Non-monetary food policy actions must not invent a budget transfer");
assert.match(html, /const isMultiPartyScenario=!parsed\.explicitTransfer/, "Conflict and treaty-like actions without a transfer must be handled as scenarios");
assert.match(html, /clarificationKind==="self"&&clarificationActors\.length===1/, "A clarified self-action must use the explicitly selected actor");
assert.match(html, /const amountLabel=action\.noBudget\?/, "Non-monetary actions must not display an invented transfer amount");
assert.match(html, /action\.noBudget\?0:/, "No-budget actions must not consume a default budget amount");
assert.doesNotMatch(html, /Exportar diagnóstico local|id="sim-export-errors"/, "Player-facing diagnostics export must not appear in the simulator");
assert.doesNotMatch(html, /function exportSimulatorDiagnostics\(/, "Player-facing diagnostic export function must be removed");
assert.match(html, /id="sim-hint-info"/, "Simulator guidance must be behind a compact info control");
assert.match(html, /Ask once in the existing speech bubble/, "Think & Recover must not render a duplicate wolf card");
assert.match(html, /if\(parsed\.negatedAction\)\{\s*clearThinkRecover\(\)/, "Negated actions must be acknowledged without asking a clarification question");
assert.match(html, /lastSimulation=\{lang,participants,actors,receivers,[\s\S]*?noChange:true/, "Negated actions must render the normal result cards as unchanged");
assert.match(html, /if\(action\?\.noChange\)/, "Negated actions must have zero impact across participant profiles");
assert.match(html, /if\(parsed\.amountAmbiguous\)/, "Multiple monetary amounts must be clarified");
assert.match(html, /if\(parsed\.negativeAmount\)/, "Negative amounts and percentages must be rejected");
assert.match(html, /if\(parsed\.negatedAction\)/, "Negated actions must never execute as positive decisions");
assert.match(html, /if\(parsed\.intentOnly\)/, "Proposals and intentions must be clarified before simulation");
assert.match(html, /if\(parsed\.multipleActionSignals>1\)/, "Multiple action verbs must trigger a clarification");
assert.match(html, /askThinkRecover\(text,lang,"multiple"\)/, "Multi-action clarification must receive the active language");
assert.match(html, /action\.requiresAmount&&parsed\.amount===null/, "Actions requiring a budget must request an explicit amount");
assert.match(html, /key:"donation",requiresAmount:false/, "Donations without an explicit amount must use the simulator's default amount");
assert.match(html, /A complete sentence always takes priority over an older clarification state/, "A complete new decision must escape stale clarification state");
assert.match(html, /if\(pendingThinkRecover&&pendingThinkRecover\.lastQuestionKind===kind\)/, "Repeated clarification of the same kind must stop instead of looping");
assert.match(html, /recordFailedDecision\(failedPhrase,kind\)/, "A repeated unresolved decision must be recorded for admin review");
assert.match(html, /copTycoonFailedDecisions/, "Failed decision reports must be stored in a separate local-only record");
assert.match(html, /id="admin-failed-decisions"/, "The admin panel must contain the failed-decision alert area");
assert.match(html, /renderFailedDecisions\(\)/, "Failed-decision alerts must render after admin login");
assert.match(html, /data-failed-reviewed/, "Admins must be able to mark failed phrases as reviewed");
assert.match(html, /if\(parsed\.negatedAction\)/, "Negation handling must remain an early decision branch");
assert.match(html, /key:"bombardment",requiresAmount:false/, "Bombardment vocabulary must be recognized without asking for a budget");
assert.match(html, /key:"price_hike",requiresAmount:false/, "Price increases must be recognized as a negative action");
assert.match(html, /key:"exploitation",requiresAmount:false/, "Exploitation vocabulary must be recognized");
assert.match(html, /key:"invasion",requiresAmount:false/, "Invasion vocabulary must be recognized");
assert.match(html, /simulationAmount<=0/, "Zero or negative amounts must not be simulated");
assert.match(html, /explicitDonationVerb/, "Explicit donation verbs must take priority over incidental purpose words");
assert.match(html, /pendingThinkRecover\.lastQuestionKind=kind/, "Clarification state must remember which role was requested");
assert.match(html, /questionKind==="actor"\|\|questionKind==="self"/, "Actor clarifications must prioritize the answer when resolving roles");
assert.match(html, /const isConcreteDecision=/, "Scenario replies must distinguish concrete decisions from general questions");
assert.match(html, /pendingThinkRecover\.scenarioOriginal=pendingThinkRecover\.original/, "Switching from a scenario question must preserve its context");
assert.match(html, /const isWhatIf=/, "What-if prompts need explicit scenario classification");
assert.match(html, /parsed\.action&&parsed\.explicitTransfer/, "Direct question-form transfers must remain actionable");
assert.match(html, /generalAnswer/, "A general-scenario clarification must not be parsed as a transaction");
assert.match(html, /pendingThinkRecover\.original/, "The original phrase must be retained during clarification");
assert.match(html, /workingText:original/, "Clarification must keep a separate working phrase while preserving the original");
assert.match(html, /const baseText=pendingThinkRecover\.workingText\|\|pendingThinkRecover\.original/, "Follow-up answers must build on the latest clarified phrase");
assert.match(html, /pendingThinkRecover\.scenarioOriginal=pendingThinkRecover\.original/, "Scenario context must remain available when switching to a concrete decision");
assert.match(html, /pendingThinkRecover\.workingText=submitted/, "A rewritten single decision must become the working phrase for later clarifications");
assert.match(html, /const safeCorrections=/, "Autocorrection must use an explicit conservative vocabulary");
assert.ok(html.includes("const corrected=original.replace("), "Autocorrection must tokenize words without touching punctuation or amounts");
assert.doesNotMatch(html, /participants\.length>1\?participants\.length-1:-1/, "No last-participant recipient fallback");
assert.match(html, /function economyTrend\(value,lang\)/, "Economy must have a localized growth/decline/stable status");
assert.match(html, /up:"en crecimiento",down:"en declive",flat:"estable"/, "Spanish economy status labels must be localized");
assert.match(html, /up:"growing",down:"declining",flat:"stable"/, "English economy status labels must be localized");
assert.match(html, /up:"en croissance",down:"en déclin",flat:"stable"/, "French economy status labels must be localized");
assert.match(html, /sim-economy-status/, "Economy card must use a simple text-only status instead of a directional arrow");
assert.doesNotMatch(html.slice(html.indexOf("const economy=profile"), html.indexOf("return '<div class=\\"sim-country-result\\"")), /simArrow\(values\.development\)/, "Economy card must not show a potentially confusing up/down arrow");
console.log("Think & Recover regression checks passed.");
