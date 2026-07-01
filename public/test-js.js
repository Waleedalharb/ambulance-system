const fs = require('fs');

// Realistic DOM mock
class MockElement {
    constructor(tag, id) {
        this.tagName = tag ? tag.toLowerCase() : 'div';
        this.id = id || '';
        this._classes = new Set();
        this.style = {};
        this._children = [];
        this._listeners = {};
        this.innerHTML = '';
        this.innerText = '';
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.parentElement = null;
        this._attrs = {};
        this._eventHandlers = {};
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(val) { this._classes = new Set(val.split(' ').filter(Boolean)); }
    get classList() {
        const self = this;
        return {
            contains: (c) => self._classes.has(c),
            add: (...c) => c.forEach(x => self._classes.add(x)),
            remove: (...c) => c.forEach(x => self._classes.delete(x)),
            toggle: (c) => { if (self._classes.has(c)) { self._classes.delete(c); return false; } else { self._classes.add(c); return true; } }
        };
    }
    addEventListener(event, handler) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(handler);
    }
    removeEventListener(event, handler) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(h => h !== handler);
        }
    }
    dispatchEvent(event) {
        if (this._listeners[event.type]) {
            this._listeners[event.type].forEach(h => h.call(this, event));
        }
    }
    setAttribute(name, value) { this._attrs[name] = String(value); }
    getAttribute(name) { return this._attrs[name] || null; }
    hasAttribute(name) { return name in this._attrs; }
    removeAttribute(name) { delete this._attrs[name]; }
    appendChild(child) {
        if (child) {
            if (child.parentElement) child.parentElement.removeChild(child);
            child.parentElement = this;
            this._children.push(child);
        }
        return child;
    }
    removeChild(child) {
        this._children = this._children.filter(c => c !== child);
        if (child) child.parentElement = null;
        return child;
    }
    insertBefore(newChild, refChild) {
        if (refChild) {
            const idx = this._children.indexOf(refChild);
            if (idx >= 0) {
                this._children.splice(idx, 0, newChild);
                newChild.parentElement = this;
            } else {
                this.appendChild(newChild);
            }
        } else {
            this.appendChild(newChild);
        }
        return newChild;
    }
    querySelector(selector) {
        if (!selector) return null;
        // ID selector
        const idMatch = selector.match(/^#([\w-]+)$/);
        if (idMatch) {
            if (this.id === idMatch[1]) return this;
            for (const child of this._children) {
                if (child.querySelector) {
                    const found = child.querySelector(selector);
                    if (found) return found;
                }
            }
            return null;
        }
        // Class selector
        const classMatch = selector.match(/^\.([\w-]+)$/);
        if (classMatch) {
            if (this._classes.has(classMatch[1])) return this;
            for (const child of this._children) {
                if (child.querySelector) {
                    const found = child.querySelector(selector);
                    if (found) return found;
                }
            }
            return null;
        }
        // Tag selector
        const tagMatch = selector.match(/^([\w-]+)$/);
        if (tagMatch) {
            if (this.tagName === tagMatch[1].toLowerCase()) return this;
            for (const child of this._children) {
                if (child.querySelector) {
                    const found = child.querySelector(selector);
                    if (found) return found;
                }
            }
            return null;
        }
        // Descendant selector (simple)
        const parts = selector.split(' ').filter(Boolean);
        if (parts.length > 1) {
            // Very simple: last part is what we want, previous parts are ancestors
            const lastPart = parts[parts.length - 1];
            for (const child of this._children) {
                if (child.querySelector) {
                    const found = child.querySelector(lastPart);
                    if (found) return found;
                }
            }
            return null;
        }
        return null;
    }
    querySelectorAll(selector) {
        const results = [];
        if (!selector) return results;
        const idMatch = selector.match(/^#([\w-]+)$/);
        if (idMatch) {
            if (this.id === idMatch[1]) results.push(this);
        }
        const classMatch = selector.match(/^\.([\w-]+)$/);
        if (classMatch) {
            if (this._classes.has(classMatch[1])) results.push(this);
        }
        const tagMatch = selector.match(/^([\w-]+)$/);
        if (tagMatch) {
            if (this.tagName === tagMatch[1].toLowerCase()) results.push(this);
        }
        for (const child of this._children) {
            if (child.querySelectorAll) {
                results.push(...child.querySelectorAll(selector));
            }
        }
        return results;
    }
    getElementsByTagName(tag) { return this.querySelectorAll(tag); }
    getElementsByClassName(cls) { return this.querySelectorAll('.' + cls); }
    focus() {}
    click() {}
    blur() {}
    insertAdjacentHTML(position, html) {
        if (position === 'beforeend') {
            this.innerHTML += html;
            this._parseHTML(html);
        } else if (position === 'afterbegin') {
            this.innerHTML = html + this.innerHTML;
            this._parseHTML(html);
        }
    }
    _parseHTML(html) {
        // Very simple parser for input elements with id
        const idMatches = html.match(/id="([^"]+)"/g);
        if (idMatches) {
            idMatches.forEach(match => {
                const id = match.match(/id="([^"]+)"/)[1];
                if (!this.querySelector('#' + id)) {
                    const el = new MockElement('div', id);
                    this.appendChild(el);
                }
            });
        }
    }
}

class MockDocument extends MockElement {
    constructor() {
        super('document');
        this.head = new MockElement('head');
        this.body = new MockElement('body');
        this.documentElement = new MockElement('html');
        this.documentElement.style = { setProperty: () => {} };
        this._allElements = {};
    }
    getElementById(id) {
        if (this._allElements[id]) return this._allElements[id];
        // Search in body and head
        const found = this.querySelector('#' + id);
        if (found) return found;
        // Create placeholder
        const el = new MockElement('div', id);
        this._allElements[id] = el;
        return el;
    }
    createElement(tag) {
        return new MockElement(tag);
    }
    createTextNode(text) {
        const el = new MockElement('text');
        el.textContent = text;
        return el;
    }
    createDocumentFragment() {
        return new MockElement('fragment');
    }
    addEventListener(event, handler) {
        if (event === 'DOMContentLoaded') {
            setTimeout(handler, 10);
        }
    }
}

const mockDocument = new MockDocument();

const mockWindow = {
    document: mockDocument,
    localStorage: {
        data: {},
        getItem: function(k) { return this.data[k] || null; },
        setItem: function(k, v) { this.data[k] = v; },
        removeItem: function(k) { delete this.data[k]; }
    },
    sessionStorage: {
        data: {},
        getItem: function(k) { return this.data[k] || null; },
        setItem: function(k, v) { this.data[k] = v; },
        removeItem: function(k) { delete this.data[k]; }
    },
    location: { href: '', reload: () => {}, pathname: '/' },
    fetch: function() { return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }), ok: true, status: 200 }); },
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    setTimeout: setTimeout,
    setInterval: setInterval,
    clearTimeout: clearTimeout,
    clearInterval: clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    WebSocket: function() { this.send = () => {}; this.close = () => {}; },
    Chart: { register: () => {} },
    L: { map: () => ({ setView: () => {}, addTo: () => {} }), tileLayer: () => ({ addTo: () => {} }), marker: () => ({ addTo: () => {}, bindPopup: () => {} }) },
    QRCode: function() { this.makeCode = () => {}; },
    html2pdf: () => Promise.resolve(),
    open: () => {},
    alert: () => {},
    confirm: () => true,
    prompt: () => '',
    console: console,
    navigator: { serviceWorker: { register: () => Promise.resolve() }, userAgent: 'node' },
    MutationObserver: function(callback) {
        this.observe = () => {};
        this.disconnect = () => {};
    },
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty: () => {} }),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    FileReader: function() { this.readAsDataURL = () => {}; this.onload = null; },
    FormData: function() { this.append = () => {}; },
    Audio: function() { this.play = () => Promise.resolve(); this.pause = () => {}; },
    XMLHttpRequest: function() { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
    atob: (str) => Buffer.from(str, 'base64').toString('binary'),
    btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
    screen: { width: 1920, height: 1080 }
};

global.document = mockDocument;
global.window = mockWindow;
global.localStorage = mockWindow.localStorage;
global.sessionStorage = mockWindow.sessionStorage;
global.fetch = mockWindow.fetch;
global.setTimeout = mockWindow.setTimeout;
global.setInterval = mockWindow.setInterval;
global.clearTimeout = mockWindow.clearTimeout;
global.clearInterval = mockWindow.clearInterval;
global.WebSocket = mockWindow.WebSocket;
global.Chart = mockWindow.Chart;
global.L = mockWindow.L;
global.QRCode = mockWindow.QRCode;
global.html2pdf = mockWindow.html2pdf;
global.navigator = mockWindow.navigator;
global.MutationObserver = mockWindow.MutationObserver;
global.getComputedStyle = mockWindow.getComputedStyle;
global.URL = mockWindow.URL;
global.FileReader = mockWindow.FileReader;
global.FormData = mockWindow.FormData;
global.Audio = mockWindow.Audio;
global.XMLHttpRequest = mockWindow.XMLHttpRequest;
global.atob = mockWindow.atob;
global.btoa = mockWindow.btoa;
global.screen = mockWindow.screen;

const errors = [];
const originalConsoleError = console.error;
console.error = function(...args) {
    errors.push(args.join(' '));
    originalConsoleError.apply(console, args);
};

const originalConsoleLog = console.log;
console.log = function(...args) {
    const msg = args.join(' ');
    originalConsoleLog.apply(console, args);
};

async function runTest() {
    try {
        const code = fs.readFileSync('js/app.js', 'utf8');
        eval(code);
        console.log('=== Execution completed ===');
        console.log('Errors captured:', errors.length);
        if (errors.length > 0) {
            console.log('Errors:');
            errors.forEach((e, i) => {
                if (i < 30) console.log((i+1) + '.', e.substring(0, 200));
            });
        } else {
            console.log('No errors captured!');
        }
    } catch (e) {
        console.log('FATAL ERROR:', e.message);
        console.log('Stack:', e.stack.substring(0, 800));
    }
}

runTest();
