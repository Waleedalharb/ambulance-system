/** تشغيل التطوير بإصدار Node المتوافق مع better-sqlite3 وتمرير --port/--host. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
function argument(name) {
    const inline = args.find(arg => arg.startsWith(name + '='));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : null;
}
function discoverNode22(startDir = ROOT) {
    const platformTag = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
    let directory = path.resolve(startDir);
    while (true) {
        const tools = path.join(directory, '.tools');
        if (fs.existsSync(tools)) {
            const versions = fs.readdirSync(tools)
                .filter(name => /^node-v22\.\d+\.\d+-/.test(name) && name.endsWith(`-${platformTag}`))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) {
                const binary = path.join(tools, version, executable);
                if (fs.existsSync(binary)) return binary;
            }
        }
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}
function compatibleNodeBinary() {
    if (process.env.NODE_BINARY) {
        const configured = path.resolve(process.env.NODE_BINARY);
        if (!fs.existsSync(configured)) throw new Error(`NODE_BINARY غير موجود: ${configured}`);
        const version = require('child_process').execFileSync(configured, ['--version'], { encoding: 'utf8' }).trim();
        if (!/^v22\./.test(version)) throw new Error(`NODE_BINARY يجب أن يكون Node 22، لكنه يعيد ${version}`);
        return configured;
    }
    if (Number(process.versions.node.split('.')[0]) === 22) return process.execPath;
    const discovered = discoverNode22();
    if (discovered) return discovered;
    throw new Error('يتطلب التطوير Node 22 المتوافق مع better-sqlite3. اضبط NODE_BINARY إلى node.exe لإصدار 22 أو ثبّته داخل .tools.');
}
function launchConfiguration() {
    const nodeBinary = compatibleNodeBinary();
    return {
        nodeBinary,
        args: [require.resolve('nodemon/bin/nodemon.js'), 'server.js'],
        options: {
            cwd: ROOT,
            env: {
                ...process.env,
                PATH: path.dirname(nodeBinary) + path.delimiter + (process.env.PATH || ''),
                PORT: String(argument('--port') || process.env.PORT || '3002'),
                HOST: String(argument('--host') || process.env.HOST || '0.0.0.0')
            },
            stdio: 'inherit'
        }
    };
}
function main() {
    const config = launchConfiguration();
    console.log(`تشغيل التطوير بواسطة Node 22: ${config.nodeBinary}`);
    const child = spawn(config.nodeBinary, config.args, config.options);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => { if (!child.killed) child.kill(signal); });
    }
    child.on('exit', (code, signal) => { process.exit(code === null ? (signal ? 1 : 0) : code); });
    child.on('error', error => { console.error('تعذر تشغيل خادم التطوير:', error.message); process.exit(1); });
}
if (require.main === module) {
    try { main(); } catch (error) { console.error('تعذر تجهيز خادم التطوير:', error.message); process.exit(1); }
}
module.exports = { argument, compatibleNodeBinary, discoverNode22, launchConfiguration };
