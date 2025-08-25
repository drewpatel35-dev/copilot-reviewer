export function isPalindrome(s){ if(typeof s!=='string') return false; const t=s.toLowerCase().replace(/[^a-z0-9]/g,''); return t===t.split('').reverse().join(''); }
export function safeJsonParse(s, fallback=null){ try{ return JSON.parse(s) }catch{ return fallback } }
export function kebabToCamel(s){ return s.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) }
