"use strict";

// Modern stand-in for the `setimmediate` polyfill, whose legacy fallbacks
// create <script> elements and build functions from strings. JSZip only needs
// a "run this callback soon" primitive, which every supported platform has.

if (typeof globalThis.setImmediate !== "function") {
	globalThis.setImmediate = function (callback) {
		var args = Array.prototype.slice.call(arguments, 1);
		return setTimeout(function () {
			callback.apply(undefined, args);
		}, 0);
	};
	globalThis.clearImmediate = function (handle) {
		clearTimeout(handle);
	};
}
