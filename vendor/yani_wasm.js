/* @ts-self-types="./yani_wasm.d.ts" */

/**
 * The session a page holds for its lifetime.
 */
export class YaniSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        YaniSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_yanisession_free(ptr, 0);
    }
    /**
     * Hand over one chain section, e.g. `("decay", "nuclides.arrow", bytes)`.
     *
     * Subsections are `decay`, `reactions`, `fission_yields` and `branching`;
     * an unknown one is an error rather than a silent drop, because a chain
     * missing a section loads as a transmutation that produces nothing.
     * @param {string} subsection
     * @param {string} file
     * @param {Uint8Array} bytes
     */
    addChainSection(subsection, file, bytes) {
        const ptr0 = passStringToWasm0(subsection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(file, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.yanisession_addChainSection(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Hand over one section of a nuclide's cross-section data and register it.
     *
     * `file` is `nuclide.arrow`, `reactions.arrow` or `version.json`, matching
     * `NEUTRON_XS_ONLY_SECTIONS`. The bytes land at `/{nuclide}.arrow/{file}`
     * in the virtual filesystem and the nuclear-data config is pointed at that
     * directory, which is what `transmute` resolves against.
     * @param {string} nuclide
     * @param {string} file
     * @param {Uint8Array} bytes
     */
    addNuclideData(nuclide, file, bytes) {
        const ptr0 = passStringToWasm0(nuclide, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(file, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.yanisession_addNuclideData(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * Set the current material from an explicit composition.
     *
     * `composition_json` maps element symbols, nuclide names or chemical
     * formulas to fractions, e.g. `{"Fe": 0.7, "Cr52": 0.2, "H2O": 0.1}`.
     * Element symbols expand over natural abundance, nuclide names are taken
     * literally, formulas are parsed -- the same rules the Python API uses.
     * @param {string} composition_json
     * @param {number} density
     * @param {string} density_units
     * @param {string} fraction_type
     * @param {number} volume
     */
    buildMaterial(composition_json, density, density_units, fraction_type, volume) {
        const ptr0 = passStringToWasm0(composition_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(density_units, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(fraction_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.yanisession_buildMaterial(this.__wbg_ptr, ptr0, len0, density, ptr1, len1, ptr2, len2, volume);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Drop the raw cross-section bytes, keeping the parsed nuclides.
     *
     * `get_or_load_nuclide` caches the parsed form globally, so once a run has
     * happened the bytes in the virtual filesystem are dead weight -- and on
     * wasm32 they are dead weight inside a 4 GB address space shared with
     * everything else. Calling this after a run roughly halves what a session
     * holds.
     *
     * The nuclear-data config still points at the same paths, so anything not
     * already parsed will fail to load until the host supplies it again.
     */
    clearNuclideData() {
        wasm.yanisession_clearNuclideData(this.__wbg_ptr);
    }
    /**
     * How many files the virtual filesystem currently holds. Diagnostics.
     * @returns {number}
     */
    fileCount() {
        const ret = wasm.yanisession_fileCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The energy boundaries of a named group structure, as a JSON array in eV.
     *
     * Any of the twelve names
     * [`yamc_nuclide::group_structures::available_group_structures`] lists, ten
     * neutron and two photon. Read back from here rather than duplicated in JS
     * so a name means the same thing in the browser as in the wheel: a second
     * copy of 710 boundaries is a second copy to drift.
     *
     * The tables are compiled in, so this needs no data.
     * @param {string} name
     * @returns {string}
     */
    groupStructure(name) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.yanisession_groupStructure(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Parse the chain from the sections handed over so far.
     *
     * Returns the number of nuclides in it, which is the host's confirmation
     * that it supplied a real chain rather than an empty one.
     * @returns {number}
     */
    loadChain() {
        const ret = wasm.yanisession_loadChain(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * The current material's nuclides and atom densities, as JSON.
     * @returns {string}
     */
    materialJson() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yanisession_materialJson(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Install the in-memory storage backend and start empty.
     *
     * Installing here rather than lazily means every later read goes through
     * it: the wasm default backend errors on every call, which is the correct
     * behaviour for a build with no filesystem but a confusing one to hit
     * halfway through a run.
     */
    constructor() {
        const ret = wasm.yanisession_new();
        this.__wbg_ptr = ret;
        YaniSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Set the current material from the PNNL compendium.
     * @param {string} name
     * @param {number} volume
     */
    pnnlMaterial(name, volume) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.yanisession_pnnlMaterial(this.__wbg_ptr, ptr0, len0, volume);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Every material name in the PNNL compendium, as a JSON array.
     *
     * The compendium is compiled in, so this needs no data and works offline.
     *
     * JSON rather than a joined string because the report's own names contain
     * commas -- "Steel, Stainless 316" is one name, not two -- so any
     * separator cheap enough to be worth using is already taken.
     * @returns {string}
     */
    static pnnlNames() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.yanisession_pnnlNames();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * PNNL names matching `query`, case-insensitively, as a JSON array.
     * @param {string} query
     * @returns {string}
     */
    static pnnlSearch(query) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.yanisession_pnnlSearch(ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The MT numbers the loaded chain names, as a sorted JSON array.
     *
     * Every reaction a run will ask a cross section for, and nothing else. The
     * host uses it to fetch only those MTs out of each `reactions.arrow`,
     * through the byte ranges `version.json` publishes: the full-grid transport
     * MTs an activation run never reads are most of every file.
     *
     * Answered here rather than computed in JS so the page needs no second copy
     * of the chain-kind-to-MT table. An MT a copy of it missed would not 404,
     * it would be a reaction rate quietly collapsing to zero.
     *
     * A chain-wide union rather than a set per nuclide, which is what
     * `transmute` itself scopes the load to. It costs no extra bytes: an MT the
     * union adds for one nuclide simply has no batch in another's file.
     * @returns {string}
     */
    requiredMts() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yanisession_requiredMts(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The nuclides a transmutation of the current material would need cross
     * sections for, as a JSON array the host fetches.
     *
     * This is the whole download budget, and it is knowable before any of it
     * is fetched -- which is what lets the UI show a byte count up front
     * rather than an open-ended spinner.
     * @returns {string}
     */
    requiredNuclides() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.yanisession_requiredNuclides(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Transmute the current material over a schedule.
     *
     * `spectra_json` is an array of `{"boundaries": [...], "values": [...]}`,
     * energies ascending in eV with one more boundary than value. The values
     * are a shape and are normalized here, so a multigroup flux can be passed
     * with its own magnitudes and the total given per step as `rate`.
     *
     * `schedule_json` is an array of `{"dt": seconds, "rate": n/cm^2/s,
     * "spectrum": index}`, where a step with no `spectrum` is decay-only.
     *
     * Returns one entry per step: cumulative time, total activity, decay heat
     * and contact dose rate, each also broken down by nuclide, the atom
     * densities, and the decay photon line spectrum. Everything the plots
     * need, in one call, so the host does not pay a boundary crossing per
     * series.
     * @param {string} spectra_json
     * @param {string} schedule_json
     * @returns {string}
     */
    run(spectra_json, schedule_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(spectra_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(schedule_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.yanisession_run(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
}
if (Symbol.dispose) YaniSession.prototype[Symbol.dispose] = YaniSession.prototype.free;

/**
 * Seconds for a `(value, unit)` duration, using the same spellings the Python
 * API accepts (`s`, `min`, `h`, `d`, `a`, and their long forms).
 * @param {number} value
 * @param {string} unit
 * @returns {number}
 */
export function durationToSeconds(value, unit) {
    const ptr0 = passStringToWasm0(unit, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.durationToSeconds(value, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

export function wasm_start() {
    wasm.wasm_start();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_ea4887a5f8f9a9db: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./yani_wasm_bg.js": import0,
    };
}

const YaniSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_yanisession_free(ptr, 1));

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('yani_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
