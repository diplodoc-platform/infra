const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const {join} = require('node:path');

/**
 * Reads a file and returns its content
 * @param {string} dir - Directory path
 * @param {string} filename - File name
 * @returns {string} File content
 */
function readFile(dir, filename) {
    const filepath = join(dir, filename);
    if (!existsSync(filepath)) {
        return null;
    }
    return readFileSync(filepath, 'utf8');
}

/**
 * Writes content to a file
 * @param {string} dir - Directory path
 * @param {string} filename - File name
 * @param {string} content - File content
 */
function writeFile(dir, filename, content) {
    const filepath = join(dir, filename);
    writeFileSync(filepath, content, 'utf8');
}

/**
 * Checks if a file exists
 * @param {string} dir - Directory path
 * @param {string} filename - File name
 * @returns {boolean}
 */
function fileExists(dir, filename) {
    return existsSync(join(dir, filename));
}

/**
 * Parses JSON file
 * @param {string} dir - Directory path
 * @param {string} filename - File name
 * @returns {object|null} Parsed JSON or null if file doesn't exist
 */
function readJson(dir, filename) {
    const content = readFile(dir, filename);
    if (content === null) {
        return null;
    }
    return JSON.parse(content);
}

/**
 * Writes JSON file
 * @param {string} dir - Directory path
 * @param {string} filename - File name
 * @param {object} data - Data to write
 */
function writeJson(dir, filename, data) {
    writeFile(dir, filename, JSON.stringify(data, null, 2));
}

module.exports = {
    readFile,
    writeFile,
    fileExists,
    readJson,
    writeJson,
};

