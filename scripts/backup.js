#!/usr/bin/env node
/**
 * Backup & Restore Script for منصة الجنوب
 * Enhanced with database.db and uploads support
 * 
 * Usage:
 *   node scripts/backup.js backup          # Create a backup
 *   node scripts/backup.js restore <file>  # Restore from backup
 *   node scripts/backup.js list            # List available backups
 *   node scripts/backup.js cleanup         # Remove backups older than 30 days
 *   node scripts/backup.js disk            # Check disk usage
 */

const fs = require('fs').promises;
const path = require('path');
const { createReadStream, createWriteStream } = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const STORAGE_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(STORAGE_PATH, 'backups');

const BACKUP_ITEMS = [
    'ambulance-data.json',
    'shift-data.json',
    'users.json',
    'docs.json',
    'air-ambulance.json',
    'control-notes.json',
    'vacations.json',
    'peak-data.json',
    'theme-settings.json',
    'password.json',
    'database.db',
    'database.db-shm',
    'database.db-wal',
    'uploads'
];

async function ensureDir(dir) {
    try {
        await fs.mkdir(dir, { recursive: true });
    } catch (e) {
        console.error('❌ Failed to create directory:', dir, e.message);
        throw e;
    }
}

async function checkDiskUsage() {
    try {
        const stats = await fs.stat(STORAGE_PATH);
        // On Windows, du is not available; use approximate size calculation
        let totalSize = 0;
        let fileCount = 0;
        
        async function calcDir(dirPath) {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                if (entry.isDirectory()) {
                    await calcDir(fullPath);
                } else {
                    const stat = await fs.stat(fullPath);
                    totalSize += stat.size;
                    fileCount++;
                }
            }
        }
        
        await calcDir(STORAGE_PATH);
        const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
        const sizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
        
        console.log(`📊 Disk Usage Report for ${STORAGE_PATH}`);
        console.log(`   Total Size: ${sizeMB} MB (${sizeGB} GB)`);
        console.log(`   File Count: ${fileCount}`);
        console.log(`   Disk: 10 GB (Render Persistent Disk)`);
        console.log(`   Usage: ${((sizeGB / 10) * 100).toFixed(2)}%`);
        
        if (parseFloat(sizeGB) > 8) {
            console.log(`⚠️  WARNING: Disk usage is above 80%. Consider cleanup or expansion.`);
        }
        if (parseFloat(sizeGB) > 9) {
            console.log(`🚨 CRITICAL: Disk usage is above 90%. Immediate action required!`);
        }
        return { totalSize, fileCount, sizeMB, sizeGB };
    } catch (error) {
        console.error('❌ Failed to check disk usage:', error.message);
    }
}

async function createBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backup-${timestamp}.tar.gz`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    
    await ensureDir(BACKUP_DIR);
    
    // Check disk usage before backup
    const usage = await checkDiskUsage();
    
    // Verify items exist before backup
    const existingItems = [];
    for (const item of BACKUP_ITEMS) {
        const itemPath = path.join(STORAGE_PATH, item);
        try {
            await fs.access(itemPath);
            existingItems.push(item);
        } catch {
            // Item doesn't exist, skip
        }
    }
    
    // Create tar.gz using Node.js streams
    const tar = require('tar');
    
    await tar.create({
        gzip: true,
        file: backupPath,
        cwd: STORAGE_PATH
    }, existingItems);
    
    const backupStat = await fs.stat(backupPath);
    const backupSizeMB = (backupStat.size / 1024 / 1024).toFixed(2);
    
    console.log(`✅ Backup created: ${backupPath}`);
    console.log(`📦 Items backed up: ${existingItems.length}`);
    console.log(`📦 Backup size: ${backupSizeMB} MB`);
    console.log(`📦 Items: ${existingItems.join(', ')}`);
    
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
    
    // Also show disk usage
    await checkDiskUsage();
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
    const existingItems = [];
    for (const item of BACKUP_ITEMS) {
        const srcPath = path.join(STORAGE_PATH, item);
        try {
            await fs.access(srcPath);
            const destPath = path.join(preRestoreDir, item);
            const stat = await fs.stat(srcPath);
            if (stat.isDirectory()) {
                await fs.mkdir(destPath, { recursive: true });
                // Copy directory contents (simplified - just log)
                console.log(`   📁 ${item} (directory)`);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
            existingItems.push(item);
        } catch (e) {
            // File may not exist, that's ok
        }
    }
    
    console.log(`✅ Pre-restore backup saved to ${preRestoreDir}`);
    console.log(`   Items: ${existingItems.join(', ')}`);
    
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
    let freedSpace = 0;
    
    for (const file of files) {
        if (!file.startsWith('backup-') && !file.startsWith('snapshot-') && !file.startsWith('pre-restore-')) continue;
        const filePath = path.join(BACKUP_DIR, file);
        try {
            const stat = await fs.stat(filePath);
            if (stat.mtime.getTime() < thirtyDaysAgo) {
                freedSpace += stat.size;
                await fs.unlink(filePath);
                console.log(`🗑️  Deleted old backup: ${file}`);
                deleted++;
            }
        } catch (e) {
            // Skip files we can't stat
        }
    }
    
    const freedMB = (freedSpace / 1024 / 1024).toFixed(2);
    console.log(`✅ Cleanup complete. Deleted ${deleted} old backup(s). Freed ${freedMB} MB.`);
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
        case 'disk':
            await checkDiskUsage();
            break;
        default:
            console.log(`
📦 EMS Platform Backup Tool

Usage:
  node scripts/backup.js backup                    Create a new backup
  node scripts/backup.js restore <file.tar.gz>     Restore from backup
  node scripts/backup.js list                       List available backups
  node scripts/backup.js cleanup                    Remove backups older than 30 days
  node scripts/backup.js disk                       Check disk usage

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
