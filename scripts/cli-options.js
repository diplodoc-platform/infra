'use strict';

const {writeFileSync, mkdirSync} = require('node:fs');
const {dirname, resolve} = require('node:path');

/** Parse the simple --flag/--key value options shared by audit CLIs. */
function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const key = argv[i].slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            flags[key] = next;
            i++;
        } else {
            flags[key] = true;
        }
    }
    return flags;
}

/** Write an explicitly requested report, creating its parent directory. */
function writeOutput(filePath, content) {
    if (!filePath) return;
    const absolute = resolve(filePath);
    mkdirSync(dirname(absolute), {recursive: true});
    writeFileSync(absolute, content, 'utf8');
}

module.exports = {parseFlags, writeOutput};
