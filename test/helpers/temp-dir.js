const {mkdtemp, rm} = require('node:fs/promises');
const {join} = require('node:path');
const {tmpdir} = require('node:os');

/**
 * Creates a temporary directory for testing
 * @returns {Promise<string>} Path to temporary directory
 */
async function createTempDir() {
    const prefix = join(tmpdir(), 'diplodoc-lint-test-');
    return await mkdtemp(prefix);
}

/**
 * Removes a temporary directory
 * @param {string} dirPath - Path to directory to remove
 * @returns {Promise<void>}
 */
async function removeTempDir(dirPath) {
    try {
        await rm(dirPath, {recursive: true, force: true});
    } catch (error) {
        // Ignore errors when removing temp dirs
        console.warn(`Warning: Failed to remove temp dir ${dirPath}:`, error.message);
    }
}

module.exports = {
    createTempDir,
    removeTempDir,
};
