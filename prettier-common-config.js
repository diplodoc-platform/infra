const baseConfig = require('@gravity-ui/prettier-config');

module.exports = {
    ...baseConfig,
    endOfLine: 'auto', // Automatically detect line endings (LF/CRLF) for cross-platform compatibility
};
