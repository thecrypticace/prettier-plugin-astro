import { createRequire } from 'node:module';
import { AstPath as AstP, Doc, ParserOptions as ParserOpts } from 'prettier';
import { createSyncFn } from 'synckit';
import { blockElements, formattableAttributes, TagName } from './elements';
import {
	anyNode,
	CommentNode,
	ExpressionNode,
	Node,
	ParentLikeNode,
	TagLikeNode,
	TextNode,
} from './nodes';

export type printFn = (path: AstPath) => Doc;
export type ParserOptions = ParserOpts<anyNode>;
export type AstPath = AstP<anyNode>;

const req = createRequire(import.meta.url);
let workerPath;
try {
	workerPath = req.resolve('../workers/serialize-worker.js');
} catch (e) {
	workerPath = req.resolve('prettier-plugin-astro/workers/serialize-worker.js');
}
const serialize = createSyncFn(req.resolve(workerPath));

export const openingBracketReplace = '_Pé';
export const closingBracketReplace = 'èP_';
export const atSignReplace = 'ΩP_';
export const dotReplace = 'ωP_';

export function isInlineElement(path: AstPath, opts: ParserOptions, node: anyNode): boolean {
	return node && node.type === 'element' && !isBlockElement(node, opts) && !isPreTagContent(path);
}

export function isBlockElement(node: anyNode, opts: ParserOptions): boolean {
	return (
		(node &&
			node.type === 'element' &&
			opts.htmlWhitespaceSensitivity !== 'strict' &&
			(opts.htmlWhitespaceSensitivity === 'ignore' ||
				blockElements.includes(node.name as TagName))) ||
		node.type === 'component' ||
		node.type === 'fragment'
	);
}

export function isIgnoreDirective(node: Node): boolean {
	return node.type === 'comment' && node.value.trim() === 'prettier-ignore';
}

/**
 *  Returns the content of the node
 */
export function printRaw(node: anyNode, stripLeadingAndTrailingNewline = false): string {
	if (!isNodeWithChildren(node)) {
		return '';
	}

	if (node.children.length === 0) {
		return '';
	}

	let raw = node.children.reduce((prev: string, curr: Node) => prev + serialize(curr), '');

	if (!stripLeadingAndTrailingNewline) {
		return raw;
	}

	if (startsWithLinebreak(raw)) {
		raw = raw.substring(raw.indexOf('\n') + 1);
	}
	if (endsWithLinebreak(raw)) {
		raw = raw.substring(0, raw.lastIndexOf('\n'));
		if (raw.charAt(raw.length - 1) === '\r') {
			raw = raw.substring(0, raw.length - 1);
		}
	}

	return raw;
}

export function isNodeWithChildren(node: anyNode): node is anyNode & ParentLikeNode {
	return node && 'children' in node && Array.isArray(node.children);
}

export const isEmptyTextNode = (node: anyNode): boolean => {
	return !!node && node.type === 'text' && getUnencodedText(node).trim() === '';
};

export function getUnencodedText(node: TextNode | CommentNode): string {
	return node.value;
}

export function isTextNodeStartingWithLinebreak(node: TextNode, nrLines = 1): node is TextNode {
	return startsWithLinebreak(getUnencodedText(node), nrLines);
}

export function startsWithLinebreak(text: string, nrLines = 1): boolean {
	return new RegExp(`^([\\t\\f\\r ]*\\n){${nrLines}}`).test(text);
}

export function endsWithLinebreak(text: string, nrLines = 1): boolean {
	return new RegExp(`(\\n[\\t\\f\\r ]*){${nrLines}}$`).test(text);
}

export function isTextNodeStartingWithWhitespace(node: Node): node is TextNode {
	return isTextNode(node) && /^\s/.test(getUnencodedText(node));
}

function endsWithWhitespace(text: string) {
	return /\s$/.test(text);
}

export function isTextNodeEndingWithWhitespace(node: Node): node is TextNode {
	return isTextNode(node) && endsWithWhitespace(getUnencodedText(node));
}

export function hasSetDirectives(node: TagLikeNode) {
	const attributes = Array.from(node.attributes, (attr) => attr.name);
	return attributes.some((attr) => ['set:html', 'set:text'].includes(attr));
}

/**
 * Check if given node's start tag should hug its first child. This is the case for inline elements when there's
 * no whitespace between the `>` and the first child.
 */
export function shouldHugStart(node: anyNode, opts: ParserOptions): boolean {
	if (isBlockElement(node, opts)) {
		return false;
	}

	if (node.type === 'fragment') {
		return false;
	}

	if (!isNodeWithChildren(node)) {
		return false;
	}

	const children = node.children;
	if (children.length === 0) {
		return true;
	}

	const firstChild = children[0];
	return !isTextNodeStartingWithWhitespace(firstChild);
}

/**
 * Check if given node's end tag should hug its last child. This is the case for inline elements when there's
 * no whitespace between the last child and the `</`.
 */
export function shouldHugEnd(node: anyNode, opts: ParserOptions): boolean {
	if (isBlockElement(node, opts)) {
		return false;
	}

	if (!isNodeWithChildren(node)) {
		return false;
	}

	const children = node.children;
	if (children.length === 0) {
		return true;
	}

	const lastChild = children[children.length - 1];
	if (isExpressionNode(lastChild)) return true;
	if (isTagLikeNode(lastChild)) return true;
	return !isTextNodeEndingWithWhitespace(lastChild);
}

/**
 * Returns true if the softline between `</tagName` and `>` can be omitted.
 */
export function canOmitSoftlineBeforeClosingTag(path: AstPath, opts: ParserOptions): boolean {
	return isLastChildWithinParentBlockElement(path, opts);
}

function getChildren(node: anyNode): Node[] {
	return isNodeWithChildren(node) ? node.children : [];
}

function isLastChildWithinParentBlockElement(path: AstPath, opts: ParserOptions): boolean {
	const parent = path.getParentNode();
	if (!parent || !isBlockElement(parent, opts)) {
		return false;
	}

	const children = getChildren(parent);
	const lastChild = children[children.length - 1];
	return lastChild === path.getNode();
}

export function trimTextNodeLeft(node: TextNode): void {
	node.value = node.value && node.value.trimStart();
}

export function trimTextNodeRight(node: TextNode): void {
	node.value = node.value && node.value.trimEnd();
}

export function printClassNames(value: string) {
	return value.trim().split(/\s+/).join(' ');
}

/** dedent string & return tabSize (the last part is what we need) */
export function manualDedent(input: string): {
	tabSize: number;
	char: string;
	result: string;
} {
	let minTabSize = Infinity;
	let result = input;
	// 1. normalize
	result = result.replace(/\r\n/g, '\n');

	// 2. count tabSize
	let char = '';
	for (const line of result.split('\n')) {
		if (!line) continue;
		// if any line begins with a non-whitespace char, minTabSize is 0
		if (line[0] && /^[^\s]/.test(line[0])) {
			minTabSize = 0;
			break;
		}
		const match = line.match(/^(\s+)\S+/); // \S ensures we don’t count lines of pure whitespace
		if (match) {
			if (match[1] && !char) char = match[1][0];
			if (match[1].length < minTabSize) minTabSize = match[1].length;
		}
	}

	// 3. reformat string
	if (minTabSize > 0 && Number.isFinite(minTabSize)) {
		result = result.replace(new RegExp(`^${new Array(minTabSize + 1).join(char)}`, 'gm'), '');
	}

	return {
		tabSize: minTabSize === Infinity ? 0 : minTabSize,
		char,
		result,
	};
}

/** True if the node is of type text */
export function isTextNode(node: anyNode): node is TextNode {
	return node.type === 'text';
}

export function isExpressionNode(node: anyNode): node is ExpressionNode {
	return node.type === 'expression';
}

/** True if the node is TagLikeNode:
 *
 * ElementNode | ComponentNode | CustomElementNode | FragmentNode */
export function isTagLikeNode(node: anyNode): node is TagLikeNode {
	return (
		node.type === 'element' ||
		node.type === 'component' ||
		node.type === 'custom-element' ||
		node.type === 'fragment'
	);
}

/**
 * Returns siblings, that is, the children of the parent.
 */
export function getSiblings(path: AstPath): anyNode[] {
	const parent = path.getParentNode();
	if (!parent) return [];

	return getChildren(parent);
}

export function getNextNode(path: AstPath): anyNode | null {
	const node = path.getNode();
	if (node) {
		const siblings = getSiblings(path);
		if (node.position?.start === siblings[siblings.length - 1].position?.start) return null;
		for (let i = 0; i < siblings.length; i++) {
			const sibling = siblings[i];
			if (sibling.position?.start === node.position?.start && i !== siblings.length - 1) {
				return siblings[i + 1];
			}
		}
	}
	return null;
}

export const isPreTagContent = (path: AstPath): boolean => {
	if (!path || !path.stack || !Array.isArray(path.stack)) return false;
	return path.stack.some(
		(node: anyNode) =>
			(node.type === 'element' && node.name.toLowerCase() === 'pre') ||
			(node.type === 'attribute' && !formattableAttributes.includes(node.name))
	);
};

interface QuoteResult {
	quote: '"' | "'";
	regex: RegExp;
	escaped: string;
}

// Adapted from Prettier's source code as it's unfortunately not exported
// https://github.com/prettier/prettier/blob/237e681936fc533c27d7ce8577d3fc98838a3314/src/common/util.js#L238
export function getPreferredQuote(rawContent: string, preferredQuote: string): QuoteResult {
	const double: QuoteResult = { quote: '"', regex: /"/g, escaped: '&quot;' };
	const single: QuoteResult = { quote: "'", regex: /'/g, escaped: '&apos;' };

	const preferred = preferredQuote === "'" ? single : double;
	const alternate = preferred === single ? double : single;

	let result = preferred;

	// If `rawContent` contains at least one of the quote preferred for enclosing
	// the string, we might want to enclose with the alternate quote instead, to
	// minimize the number of escaped quotes.
	if (rawContent.includes(preferred.quote) || rawContent.includes(alternate.quote)) {
		const numPreferredQuotes = (rawContent.match(preferred.regex) || []).length;
		const numAlternateQuotes = (rawContent.match(alternate.regex) || []).length;

		result = numPreferredQuotes > numAlternateQuotes ? alternate : preferred;
	}

	return result;
}
