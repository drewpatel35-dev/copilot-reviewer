export function add(a,b){return a+b}

export function sub(a,b){return a-b}export function clamp(x, min, max){ if(min>max) throw new Error("min>max"); return Math.max(min, Math.min(max, x)); }
export function div(a,b){ if(b===0) throw new Error("div by zero"); return a/b; }
