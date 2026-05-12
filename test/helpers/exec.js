const {exec} = require('node:child_process');
const {promisify} = require('node:util');

const execAsync = promisify(exec);

/**
 * Executes a command in a directory
 * @param {string} command - Command to execute
 * @param {string} cwd - Working directory
 * @param {object} options - Additional options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function execInDir(command, cwd, options = {}) {
    const {env = {}} = options;
    const result = await execAsync(command, {
        cwd,
        env: {...process.env, ...env},
        ...options,
    });
    return result;
}

module.exports = {
    execInDir,
};
