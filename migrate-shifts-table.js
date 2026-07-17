/**
 * Migration: Update shifts table to add missing columns
 * Run once: node migrate-shifts-table.js
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.db');

try {
    const db = new Database(DB_PATH);
    console.log('Connected to database:', DB_PATH);

    // Check existing columns
    const columns = db.pragma('table_info(shifts)');
    const columnNames = columns.map(c => c.name);
    console.log('Existing columns:', columnNames);

    // Add missing columns one by one
    const migrations = [
        { name: 'end_time', sql: 'ALTER TABLE shifts ADD COLUMN end_time DATETIME' },
        { name: 'updated_at', sql: 'ALTER TABLE shifts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP' },
        { name: 'archived_at', sql: 'ALTER TABLE shifts ADD COLUMN archived_at DATETIME' },
    ];

    for (const migration of migrations) {
        if (!columnNames.includes(migration.name)) {
            try {
                db.exec(migration.sql);
                console.log(`✅ Added column: ${migration.name}`);
            } catch (e) {
                console.log(`⚠️ Column ${migration.name}: ${e.message}`);
            }
        } else {
            console.log(`⏭️ Column ${migration.name} already exists`);
        }
    }

    // Verify
    const newColumns = db.pragma('table_info(shifts)');
    console.log('\nUpdated columns:', newColumns.map(c => c.name).join(', '));
    console.log('✅ Migration complete');

    db.close();
} catch (e) {
    console.error('❌ Migration failed:', e.message);
    process.exit(1);
}