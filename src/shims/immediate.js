"use strict";

// Modern stand-in for the `immediate` package (an Internet-Explorer-era
// setImmediate shim that falls back to injecting <script> elements).
// Obsidian runs on Chromium, where queueMicrotask is always available.

module.exports = function immediate(task) {
	var args = Array.prototype.slice.call(arguments, 1);
	queueMicrotask(function () {
		task.apply(undefined, args);
	});
};
