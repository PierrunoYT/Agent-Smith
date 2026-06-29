const fs = require('fs');

const legacyToolsPath = process.argv[2];
const legacyIndex = process.argv[3];
const targetToolsPath = process.argv[4] || 'src/renderer/modes/agentTools.js';

if (!legacyToolsPath || !legacyIndex) {
    throw new Error(
        'Usage: node replace-tools.js <legacy-tools.js> <legacy-index.js> [target-agentTools.js]'
    );
}

function readRequired(filePath, description) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${description} not found at ${filePath}. Usage: node replace-tools.js <legacy-tools.js> <legacy-index.js> [target-agentTools.js]`);
    }
    return fs.readFileSync(filePath, 'utf8');
}

let legacyToolsContent = readRequired(legacyToolsPath, 'Legacy tools file');
let targetContent = readRequired(targetToolsPath, 'Target Agent tools file');
let legacyIndexContent = readRequired(legacyIndex, 'Legacy index file');

// Extract AGENT_TOOLS from legacy
const toolsMatch = legacyToolsContent.match(/const AGENT_TOOLS = \[([\s\S]*?)\];/);
if (!toolsMatch) throw new Error("Could not find AGENT_TOOLS in legacy tools.js");
const legacyToolsArray = `const AGENT_SYS_TOOLS = [${toolsMatch[1]}];`;

// Extract SYSTEM_PROMPT from legacy index.js
const promptMatch = legacyIndexContent.match(/const SYSTEM_PROMPT = "(.*?)";/);
if (!promptMatch) throw new Error("Could not find SYSTEM_PROMPT in legacy index.js");
const legacyPrompt = promptMatch[1].replace(/\\n/g, '\n');

// The new system appendix should be the exact legacy prompt.
const newAppendix = `const AGENT_MODE_SYSTEM_APPENDIX = \`${legacyPrompt}\`;`;

// Now we need to replace AGENT_SYS_TOOLS and AGENT_MODE_SYSTEM_APPENDIX in targetContent.
targetContent = targetContent.replace(/const AGENT_SYS_TOOLS = \[[\s\S]*?\];/, legacyToolsArray);
targetContent = targetContent.replace(/const AGENT_MODE_SYSTEM_APPENDIX = `[\s\S]*?`;/, newAppendix);

fs.writeFileSync('temp_agentTools.js', targetContent);
console.log("Extracted legacy tools and prompt to temp_agentTools.js");