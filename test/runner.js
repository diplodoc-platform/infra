#!/usr/bin/env node

/**
 * Simple test runner for unit and integration tests
 */

const {readdirSync, statSync} = require('node:fs');
const {join} = require('node:path');

const testDir = __dirname;
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

async function runTestFile(filePath) {
    // Clear require cache to allow re-running tests
    delete require.cache[require.resolve(filePath)];
    const testModule = require(filePath);

    if (testModule.tests && Array.isArray(testModule.tests)) {
        // If test file exports tests array
        for (const test of testModule.tests) {
            totalTests++;
            try {
                await test.fn();
                passedTests++;
                console.log(`  ✓ ${test.name}`);
            } catch (error) {
                failedTests++;
                console.error(`  ✗ ${test.name}`);
                console.error(`    ${error.message}`);
                if (error.stack) {
                    const stackLines = error.stack.split('\n').slice(0, 3);
                    console.error(`    ${stackLines.join('\n    ')}`);
                }
                failures.push({file: filePath, test: test.name, error});
            }
        }
    } else {
        console.warn(`  ⚠ ${filePath} does not export tests array`);
    }
}

async function runTestsInDir(dir, type) {
    const files = readdirSync(dir);
    const testFiles = files.filter((f) => f.endsWith('.test.js'));

    if (testFiles.length === 0) {
        return;
    }

    console.log(`\n${type} Tests:`);
    console.log('='.repeat(50));

    for (const file of testFiles) {
        const filePath = join(dir, file);
        console.log(`\nRunning ${file}...`);

        try {
            await runTestFile(filePath);
        } catch (error) {
            failedTests++;
            console.error(`  ✗ Failed to run ${file}`);
            console.error(`    ${error.message}`);
            failures.push({file: filePath, test: 'file execution', error});
        }
    }
}

async function main() {
    const filter = process.argv[2]; // 'unit' or 'integration' or undefined for all

    console.log('Running tests...\n');

    // Run unit tests
    if (!filter || filter === 'unit') {
        const unitDir = join(testDir, 'unit');
        if (statSync(unitDir).isDirectory()) {
            await runTestsInDir(unitDir, 'Unit');
        }
    }

    // Run integration tests
    if (!filter || filter === 'integration') {
        const integrationDir = join(testDir, 'integration');
        if (statSync(integrationDir).isDirectory()) {
            await runTestsInDir(integrationDir, 'Integration');
        }
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  Total: ${totalTests}`);
    console.log(`  Passed: ${passedTests}`);
    console.log(`  Failed: ${failedTests}`);

    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const {file, test, error} of failures) {
            console.log(`  ${file} - ${test}`);
            if (error.stack) {
                console.log(`    ${error.stack.split('\n')[0]}`);
            }
        }
        process.exit(1);
    } else {
        console.log('\nAll tests passed!');
        process.exit(0);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Test runner error:', error);
        process.exit(1);
    });
}

module.exports = {runTestFile};
