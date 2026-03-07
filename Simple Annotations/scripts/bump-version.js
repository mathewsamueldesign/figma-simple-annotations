const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Determine paths relative to this script
const projectDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectDir, 'package.json');
const uiHtmlPath = path.join(projectDir, 'ui.html');

console.log('Bumping version...');

try {
    // Bump the patch version in package.json without creating a git commit or tag
    execSync('npm version patch --no-git-tag-version', { cwd: projectDir, stdio: 'inherit' });
} catch (error) {
    console.error('Failed to bump version in package.json:', error.message);
    process.exit(1);
}

// Read the newly minted version
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const newVersion = packageJson.version;
console.log(`New version is v${newVersion}`);

// Update the version in ui.html
if (fs.existsSync(uiHtmlPath)) {
    let uiHtml = fs.readFileSync(uiHtmlPath, 'utf8');
    // Regex to match the exact placeholder we injected: <div class="version-number" id="plugin-version">v1.2.3</div>
    const versionRegex = /<div class="version-number" id="plugin-version">v[0-9.]+<\/div>/;

    if (versionRegex.test(uiHtml)) {
        uiHtml = uiHtml.replace(versionRegex, `<div class="version-number" id="plugin-version">v${newVersion}</div>`);
        fs.writeFileSync(uiHtmlPath, uiHtml);
        console.log(`Successfully updated ui.html isolated version element to v${newVersion}`);
    } else {
        console.warn('Could not find the specific version element <div class="version-number" id="plugin-version">...</div> in ui.html.');
    }
} else {
    console.warn('ui.html not found, skipping UI update.');
}
