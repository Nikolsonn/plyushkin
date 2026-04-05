/**
 * Standalone migration script.
 * Run with: node dist/database/migrate.js
 */
import '../config'; // Load env
import { migrateDb, closeDb } from './db';

migrateDb();
closeDb();
console.log('Migration complete.');
