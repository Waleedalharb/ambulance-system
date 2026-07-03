const fs = require('fs');
const serverPath = 'server.js';
let server = fs.readFileSync(serverPath, 'utf-8');

// Fix 1: getShiftType - make all methods return consistent values ('صباح' or 'ليل')
const oldGetShiftType = `function getShiftType(shift) {
            // Method 1: Use explicit shiftType if it's valid
            if (shift.shiftType) {
                const normalized = shift.shiftType.trim();
                if (normalized === 'صباحية' || normalized === 'صباح' || normalized === 'morning' || normalized === 'day') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (day):', normalized);
                    return 'صباح';
                }
                if (normalized === 'ليلية' || normalized === 'ليل' || normalized === 'night' || normalized === 'evening') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (night):', normalized);
                    return 'ليل';
                }
            }
            
            // Method 2: Derive from startTime (most reliable)
            // Convert UTC to Saudi Arabia time (UTC+3) before checking hour
            if (shift.startTime) {
                const startDate = new Date(shift.startTime);
                const utcHour = startDate.getUTCHours();
                const saudiHour = (utcHour + 3) % 24;
                const derived = (saudiHour >= 17 || saudiHour < 5) ? 'ليلية' : 'صباحية';
                console.log('[SHIFT-TYPE] startTime:', shift.startTime, 'UTC hour:', utcHour, 'Saudi hour:', saudiHour, '→', derived);
                return derived;
            }
            
            // Method 3: Derive from shiftName
            if (shift.shiftName) {
                if (shift.shiftName.includes('ليل')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (night):', shift.shiftName);
                    return 'ليلية';
                }
                if (shift.shiftName.includes('صباح')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (day):', shift.shiftName);
                    return 'صباحية';
                }
            }
            
            // Method 4: Fallback to current time (Saudi Arabia UTC+3)
            const now = new Date();
            const nowUtcHour = now.getUTCHours();
            const nowSaudiHour = (nowUtcHour + 3) % 24;
            const fallback = (nowSaudiHour >= 17 || nowSaudiHour < 5) ? 'ليلية' : 'صباحية';
            console.log('[SHIFT-TYPE] Fallback current UTC:', nowUtcHour, 'Saudi:', nowSaudiHour, '→', fallback);
            return fallback;
        }`;

const newGetShiftType = `function getShiftType(shift) {
            // Method 1: Use explicit shiftType if it's valid
            if (shift.shiftType) {
                const normalized = shift.shiftType.trim();
                if (normalized === 'صباحية' || normalized === 'صباح' || normalized === 'morning' || normalized === 'day') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (day):', normalized);
                    return 'صباح';
                }
                if (normalized === 'ليلية' || normalized === 'ليل' || normalized === 'night' || normalized === 'evening') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (night):', normalized);
                    return 'ليل';
                }
            }
            
            // Method 2: Derive from startTime (most reliable)
            // Convert UTC to Saudi Arabia time (UTC+3) before checking hour
            if (shift.startTime) {
                const startDate = new Date(shift.startTime);
                const utcHour = startDate.getUTCHours();
                const saudiHour = (utcHour + 3) % 24;
                const derived = (saudiHour >= 17 || saudiHour < 5) ? 'ليل' : 'صباح';
                console.log('[SHIFT-TYPE] startTime:', shift.startTime, 'UTC hour:', utcHour, 'Saudi hour:', saudiHour, '→', derived);
                return derived;
            }
            
            // Method 3: Derive from shiftName
            if (shift.shiftName) {
                if (shift.shiftName.includes('ليل')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (night):', shift.shiftName);
                    return 'ليل';
                }
                if (shift.shiftName.includes('صباح')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (day):', shift.shiftName);
                    return 'صباح';
                }
            }
            
            // Method 4: Fallback to current time (Saudi Arabia UTC+3)
            const now = new Date();
            const nowUtcHour = now.getUTCHours();
            const nowSaudiHour = (nowUtcHour + 3) % 24;
            const fallback = (nowSaudiHour >= 17 || nowSaudiHour < 5) ? 'ليل' : 'صباح';
            console.log('[SHIFT-TYPE] Fallback current UTC:', nowUtcHour, 'Saudi:', nowSaudiHour, '→', fallback);
            return fallback;
        }`;

server = server.replace(oldGetShiftType, newGetShiftType);

// Fix 2: Improve shift code filtering
const oldCodeFilter = `        // Define valid shift codes for each shift type
        const dayShiftCodes = ['D12', 'D10', 'D11', 'D8', 'D6', 'M', 'CPD', 'CP8', 'CP24', 'C', 'O12', 'O10', 'O6', 'F', 'ME'];
        const nightShiftCodes = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN', 'CP24', 'C', 'O12', 'O10', 'O6', 'ME', 'F'];
        const validCodes = isNightShift ? nightShiftCodes : dayShiftCodes;
        
        // Filter paramedics: only show those whose shift code matches current shift type
        const filteredParamedics = paramedics.filter(p => {
            if (!p.shift_code) return false;
            return validCodes.includes(p.shift_code.toUpperCase());
        });
        
        const absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
        const paramedicsWithStatus = filteredParamedics.map(p => ({
            ...p,
            status: p.shift_code && absentCodes.includes(p.shift_code.toUpperCase()) ? 'غائب' : 'حاضر'
        }));
        
        res.json({ paramedics: paramedicsWithStatus, shiftDate, teamName, shiftType });`;

const newCodeFilter = `        // Define shift code categories for proper filtering
        const dayOnlyCodes = ['D12', 'D10', 'D11', 'D8', 'D6', 'CPD', 'CP8'];
        const nightOnlyCodes = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN'];
        const sharedCodes = ['CP24', 'M', 'ME', 'F', 'O12', 'O10', 'O6'];
        const offCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
        
        const validCodes = isNightShift 
            ? [...nightOnlyCodes, ...sharedCodes] 
            : [...dayOnlyCodes, ...sharedCodes];
        
        // Filter paramedics: show working codes for this shift + all off codes (to show as absent)
        const filteredParamedics = paramedics.filter(p => {
            if (!p.shift_code) return false;
            const codeUpper = p.shift_code.toUpperCase();
            return validCodes.includes(codeUpper) || offCodes.includes(codeUpper);
        });
        
        // Map paramedics with accurate status using database shift_status
        const paramedicsWithStatus = filteredParamedics.map(p => {
            const codeUpper = p.shift_code ? p.shift_code.toUpperCase() : '';
            const isOff = offCodes.includes(codeUpper);
            // Use actual shift_status from database for accurate display
            const actualStatus = p.shift_status || '';
            const displayStatus = isOff ? 'غائب' : 'حاضر';
            return {
                ...p,
                status: displayStatus,
                actualStatus: actualStatus
            };
        });
        
        res.json({ paramedics: paramedicsWithStatus, shiftDate, teamName, shiftType });`;

server = server.replace(oldCodeFilter, newCodeFilter);

fs.writeFileSync(serverPath, server, 'utf-8');
console.log('Done! Fixed getShiftType and shift code filtering.');
