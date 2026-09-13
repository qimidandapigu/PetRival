import { parseExpression } from '@babel/parser/lib/index.js';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { ACTIONS } from '../shared/boxing.mjs';

export const SKILL_CAPACITY = 100;
export const SKILL_TOKENIZER = 'o200k_base';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const methods = new Set(['find', 'filter', 'some', 'every', 'includes']);
const binary = new Set(['===', '!==', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%']);
const fail = message => { throw new Error(message); };

// Compile a small, explicit TS subset to data. User code is never passed to eval,
// Function, node:vm or the host JS runtime. Both Node and Workers use this interpreter.
export function compileSkill(code) {
  if (typeof code !== 'string' || code.length > 4096) fail('技能代码最多 4096 个字符');
  let root;
  try { root = parseExpression(code, { plugins: ['typescript'] }); }
  catch { fail('TS 语法错误，请使用 (ctx: SkillContext) => …'); }
  let count = 0;
  function compile(n, scope = new Set(), depth = 0) {
    if (!n || ++count > 512 || depth > 32) fail('技能结构过于复杂');
    const sub = node => compile(node, scope, depth + 1);
    switch (n.type) {
      case 'ArrowFunctionExpression': {
        if (n.async || n.params.length !== 1 || n.params[0].type !== 'Identifier') fail('函数只接受一个参数，不支持异步');
        const name = n.params[0].name;
        if (forbidden.has(name)) fail('不支持此参数名');
        return ['fn', name, compile(n.body, new Set([...scope, name]), depth + 1)];
      }
      case 'BlockStatement': {
        const local = new Set(scope), statements = [];
        for (const s of n.body) {
          statements.push(compile(s, local, depth + 1));
          if (s.type === 'VariableDeclaration') for (const d of s.declarations) local.add(d.id.name);
        }
        return ['block', statements];
      }
      case 'VariableDeclaration':
        if (n.kind !== 'const' || n.declarations.length !== 1 || n.declarations[0].id.type !== 'Identifier' || !n.declarations[0].init) fail('局部变量请使用单个 const 声明');
        if (forbidden.has(n.declarations[0].id.name) || scope.has(n.declarations[0].id.name)) fail('变量名重复或不支持');
        return ['const', n.declarations[0].id.name, sub(n.declarations[0].init)];
      case 'ReturnStatement': return ['return', n.argument ? sub(n.argument) : ['value', null]];
      case 'IfStatement': return ['if', sub(n.test), sub(n.consequent), n.alternate ? sub(n.alternate) : ['value', null]];
      case 'Identifier':
        if (!scope.has(n.name)) fail(`不能访问 ${n.name}；只允许当前局面和局部变量`);
        return ['get', n.name];
      case 'StringLiteral': case 'NumericLiteral': case 'BooleanLiteral': return ['value', n.value];
      case 'NullLiteral': return ['value', null];
      case 'MemberExpression': case 'OptionalMemberExpression': {
        if (!n.computed && forbidden.has(n.property.name)) fail('不能访问对象原型');
        return ['member', sub(n.object), n.computed ? sub(n.property) : ['value', n.property.name], !!n.optional];
      }
      case 'CallExpression': {
        const m = n.callee;
        if (m.type !== 'MemberExpression' || m.computed || !methods.has(m.property.name) || n.arguments.length !== 1) fail('只允许数组 find/filter/some/every/includes 调用');
        return ['call', sub(m.object), m.property.name, sub(n.arguments[0])];
      }
      case 'LogicalExpression':
        if (!['&&', '||', '??'].includes(n.operator)) fail('不支持此逻辑运算');
        return ['logic', n.operator, sub(n.left), sub(n.right)];
      case 'BinaryExpression':
        if (!binary.has(n.operator)) fail('不支持此运算');
        return ['binary', n.operator, sub(n.left), sub(n.right)];
      case 'UnaryExpression':
        if (!['!', '-', '+'].includes(n.operator)) fail('不支持此一元运算');
        return ['unary', n.operator, sub(n.argument)];
      case 'ConditionalExpression': return ['conditional', sub(n.test), sub(n.consequent), sub(n.alternate)];
      default: fail(`不支持的 TS 语法：${n.type}；请使用条件判断和数组查询`);
    }
  }
  if (root.type !== 'ArrowFunctionExpression') fail('技能必须是一个箭头函数');
  return compile(root);
}

export function runSkill(program, context) {
  let budget = 2000;
  const returned = Symbol('return');
  function call(fn, value) {
    if (!fn || fn.kind !== 'closure') fail('数组查询需要一个判断函数');
    const env = new Map(fn.env); env.set(fn.name, value);
    const result = evaluate(fn.body, env);
    return result?.kind === returned ? result.value : result;
  }
  function evaluate(n, env) {
    if (--budget < 0) fail('技能超出执行预算');
    const ev = node => evaluate(node, env);
    switch (n[0]) {
      case 'value': return n[1];
      case 'get': return env.get(n[1]);
      case 'fn': return { kind: 'closure', name: n[1], body: n[2], env: new Map(env) };
      case 'block': {
        const local = new Map(env);
        for (const s of n[1]) { const result = evaluate(s, local); if (result?.kind === returned) return result; }
        return null;
      }
      case 'const': env.set(n[1], ev(n[2])); return null;
      case 'return': return { kind: returned, value: ev(n[1]) };
      case 'if': return ev(ev(n[1]) ? n[2] : n[3]);
      case 'conditional': return ev(ev(n[1]) ? n[2] : n[3]);
      case 'member': {
        const object = ev(n[1]), key = ev(n[2]);
        if (typeof key !== 'string' && typeof key !== 'number') fail('属性名必须是字符串或数字');
        if (forbidden.has(String(key))) fail('不能访问对象原型');
        if (object == null) { if (n[3]) return undefined; fail('读取了不存在的对象，请用 ?.'); }
        if (object?.kind === 'closure') fail('不能读取函数属性');
        return Object.hasOwn(Object(object), key) ? object[key] : undefined;
      }
      case 'call': {
        const list = ev(n[1]), arg = ev(n[3]);
        if (!Array.isArray(list) || list.length > 64) fail('查询对象必须是局面中的数组');
        if (n[2] === 'includes') return list.includes(arg);
        // Array prototypes come from the trusted runtime, never from skill data.
        return Array.prototype[n[2]].call(list, item => Boolean(call(arg, item)));
      }
      case 'logic': {
        const left = ev(n[2]);
        return n[1] === '&&' ? left && ev(n[3]) : n[1] === '||' ? left || ev(n[3]) : left ?? ev(n[3]);
      }
      case 'unary': { const v = ev(n[2]); return n[1] === '!' ? !v : n[1] === '-' ? -v : +v; }
      case 'binary': {
        const a = ev(n[2]), b = ev(n[3]);
        if (![a, b].every(v => v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v))) fail('运算只支持基础值');
        switch (n[1]) {
          case '===': return a === b; case '!==': return a !== b;
          case '==': return a == b; case '!=': return a != b;
          case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
          case '+': { const v = a + b; if (typeof v === 'string' && v.length > 4096) fail('字符串过长'); return v; }
          case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
        }
      }
      default: fail('技能指令无效');
    }
  }
  const result = call(evaluate(program, new Map()), context);
  if (result != null && typeof result !== 'string') fail('技能必须返回该项目的动作字符串或 null');
  return result ?? null;
}

export function checkSkill(input) {
  let tokens = null;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['name', 'description', 'code', 'gameId'].includes(k))) fail('技能只接受名称、项目、描述和代码');
    if (!['sokoban', 'boxing'].includes(input.gameId)) fail('技能项目只支持推箱子或打拳');
    if (typeof input.name !== 'string' || !input.name.trim() || [...input.name].length > 24) fail('技能名称需要 1–24 个字');
    if (typeof input.description !== 'string' || input.description.length > 4096 || typeof input.code !== 'string' || input.code.length > 4096) fail('描述和代码各最多 4096 个字符');
    // Sum the two exact saved fields. Formatting, comments and TS annotations count.
    const count = text => encode(text, { disallowedSpecial: new Set() }).length;
    tokens = count(input.description) + count(input.code);
    if (tokens > SKILL_CAPACITY) fail(`技能描述 + TS 代码共 ${tokens} token，超过 ${SKILL_CAPACITY} 上限`);
    if (!input.description.trim() || !input.code.trim()) fail('请填写技能描述和 TS 代码');
    const program = compileSkill(input.code);
    return { valid: true, tokens, capacity: SKILL_CAPACITY, tokenizer: SKILL_TOKENIZER, program };
  } catch (error) { return { valid: false, tokens, capacity: SKILL_CAPACITY, tokenizer: SKILL_TOKENIZER, error: error.message }; }
}

export function skillView(pet, privateView = false) {
  const skill = pet.competitionSkill;
  return { capacity: SKILL_CAPACITY, slots: 1, tokenizer: SKILL_TOKENIZER, revision: pet.skillRevision || 0,
    equipped: skill ? { name: skill.name, gameId: skill.gameId, tokens: skill.tokens,
      ...(privateView ? { description: skill.description, code: skill.code } : {}) } : null };
}

export function skillDecision(skill, observation) {
  if (!skill || skill.gameId !== 'sokoban') return { choice: null, status: null };
  try {
    // Revalidate saved source so a corrupt/old record never becomes host code.
    const checked = checkSkill({ name: skill.name, description: skill.description, code: skill.code, gameId: skill.gameId });
    if (!checked.valid) fail(checked.error);
    const choice = runSkill(checked.program, observation);
    if (choice !== null && !(choice === 'restart' || choice === 'undo' && observation.canUndo || observation.availablePushes.some(p => p.id === choice))) fail('技能返回了当前不可用的动作');
    return { choice, status: { name: skill.name, state: choice === null ? 'fallback' : 'used', message: choice === null ? '未触发，使用原有决策' : `技能选择 ${choice}` } };
  } catch (error) { return { choice: null, status: { name: skill.name, state: 'error', message: `${error.message}；使用原有决策` } }; }
}

export function boxingSkillDecision(skill, observation) {
  if (!skill || skill.gameId !== 'boxing') return { choice: null, status: null };
  try {
    const checked = checkSkill({ name: skill.name, description: skill.description, code: skill.code, gameId: skill.gameId });
    if (!checked.valid) fail(checked.error);
    const choice = runSkill(checked.program, observation);
    if (choice !== null && !ACTIONS.includes(choice)) fail('技能返回了拳台不支持的动作');
    return { choice, status: { name: skill.name, state: choice === null ? 'fallback' : 'used', message: choice === null ? '未触发，使用原有决策' : `技能选择 ${choice}` } };
  } catch (error) { return { choice: null, status: { name: skill.name, state: 'error', message: `${error.message}；使用原有决策` } }; }
}
