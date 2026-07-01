#!/usr/bin/env node
/**
 * Backup & Restore Script for منصة الجنوب
 * 
 * Usage:
 *   node scripts/backup.js backup          # Create a backup
 *   node scripts/backup.js restore <file>  # Restore from backup
 *   node scripts/backup.js list            # List available backups
 *   node scripts/backup.js cleanup         # Remove backups older than 30 days
 * 
 * Environment:
 *   BACKUP_DIR   - Directory to store backups (default: /data/backups or ./data/backups)
 *   DATA_DIR     - Directory containing data files (default: /data or ./data)
 */

const fs = require('fs').promises;
const path = require('path');
const { createReadStream, createWriteStream } = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const STORAGE_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(STORAGE_PATH, 'backups');

const DATA_FILES = [
    'ambulance-data.json',
    'shift-data.json',
    'users.json',
    'docs.json',
    'air-ambulance.json',
    'control-notes.json',
    'vacations.json',
    'peak-data.json',
    'theme-settings.json',
    'password.json'
];

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (e) {
        console.error('❌ Failed to create directory:', dir, e.message);
        throw e;
    }
}

async function createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.tar.gz`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    
    await ensureDir(BACKUP_DIR);
    
    // Create a simple tar.gz using Node.js streams
    const tar = require('tar');
    
    await tar.create({
        gzip: true,
        file: backupPath,
        cwd: STORAGE_PATH
    }, DATA_FILES);
    
    console.log(`✅ Backup created: ${backupPath}`);
    console.log(`📦 Files backed up: ${DATA_FILES.join(', ')}`);
    
    // Also create a quick JSON snapshot for easy recovery
    const snapshotName = `snapshot-${timestamp}.json`;
    const snapshotPath = path.join(BACKUP_DIR, snapshotName);
    const snapshot = {};
    for (const file of DATA_FILES) {
        const filePath = path.join(STORAGE_PATH, file);
        try {
            const data = await fs.readFile(filePath, 'utf8');
            snapshot[file] = JSON.parse(data);
        } catch (e) {
            snapshot[file] = null;
        }
    }
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(`📸 JSON snapshot created: ${snapshotPath}`);
    
    return backupPath;
}

async function listBackups() {
    await ensureDir(BACKUP_DIR);
    const files = await fs.readdir(BACKUP_DIR);
    const backups = files.filter(f => f.startsWith('backup-') || f.startsWith('snapshot-'));
    
    if (backups.length === 0) {
        console.log('📭 No backups found');
        return;
    }
    
    console.log(`📦 ${backups.length} backup(s) found in ${BACKUP_DIR}:`);
    for (const file of backups) {
        const stat = await fs.stat(path.join(BACKUP_DIR, file));
        const size = (stat.size / 1024 / 1024).toFixed(2);
        const date = stat.mtime.toISOString();
        console.log(`  - ${file} (${size} MB) - ${date}`);
    }
}

async function restoreBackup(backupFile) {
    const backupPath = path.resolve(backupFile);
    
    if (!backupPath.endsWith('.tar.gz')) {
        console.error('❌ Backup file must be a .tar.gz archive');
        process.exit(1);
    }
    
    // Verify backup exists
    try {
        await fs.access(backupPath);
    } catch {
        console.error('❌ Backup file not found:', backupPath);
        process.exit(1);
    }
    
    // Create restore timestamp
    const restoreTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRestoreDir = path.join(BACKUP_DIR, `pre-restore-${restoreTimestamp}`);
    await ensureDir(preRestoreDir);
    
    // Backup current data before restoring
    console.log('📦 Creating pre-restore backup...');
    for (const file of DATA_FILES) {
        const srcPath = path.join(STORAGE_PATH, file);
        const destPath = path.join(preRestoreDir, file);
        try {
            await fs.copyFile(srcPath, destPath);
        } catch (e) {
            // File may not exist, that's ok
        }
    }
    console.log(`✅ Pre-restore backup saved to ${preRestoreDir}`);
    
    // Extract backup
    const tar = require('tar');
    await tar.extract({
        file: backupPath,
        cwd: STORAGE_PATH,
        gzip: true
    });
    
    console.log(`✅ Restored from ${backupPath}`);
    console.log(`⚠️  Current data was backed up to ${preRestoreDir} before restore`);
}

async function cleanupOldBackups() {
    await ensureDir(BACKUP_DIR);
    const files = await fs.readdir(BACKUP_DIR);
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let deleted = 0;
    
    for (const file of files) {
        if (!file.startsWith('backup-') && !file.startsWith('snapshot-')) continue;
        const filePath = path.join(BACKUP_DIR, file);
        const stat = await fs.stat(filePath);
        if (stat.mtime.getTime() < thirtyDaysAgo) {
            await fs.unlink(filePath);
            console.log(`🗑️  Deleted old backup: ${file}`);
            deleted++;
        }
    }
    
    console.log(`✅ Cleanup complete. Deleted ${deleted} old backup(s).`);
}

async function main() {
    const command = process.argv[2];
    
    switch (command) {
        case 'backup':
            await createBackup();
            break;
        case 'restore':
            const file = process.argv[3];
            if (!file) {
                console.error('❌ Usage: node scripts/backup.js restore <backup-file.tar.gz>');
                process.exit(1);
            }
            await restoreBackup(file);
            break;
        case 'list':
            await listBackups();
            break;
        case 'cleanup':
            await cleanupOldBackups();
            break;
        default:
            console.log(`
📦 EMS Platform Backup Tool

Usage:
  node scripts/backup.js backup                    Create a new backup
  node scripts/backup.js restore <file.tar.gz>     Restore from backup
  node scripts/backup.js list                      List available backups
  node scripts/backup.js cleanup                   Remove backups older than 30 days

Environment Variables:
  BACKUP_DIR    - Backup storage directory
  DATA_DIR      - Data files directory
            `);
    }
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
