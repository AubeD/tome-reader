"use strict";

// epub.js imports localforage for its optional offline Store (browser storage
// for cached books). Tome never enables that feature — books are read straight
// from the vault — so the dependency is replaced with a stub. This keeps the
// plugin free of localStorage/IndexedDB access it would otherwise carry.

function notEnabled() {
	return Promise.reject(new Error("Tome Reader: the epub.js offline store is not enabled"));
}

var stub = {
	config: function () {},
	createInstance: function () {
		return stub;
	},
	defineDriver: notEnabled,
	ready: notEnabled,
	getItem: notEnabled,
	setItem: notEnabled,
	removeItem: notEnabled,
	clear: notEnabled,
	length: notEnabled,
	key: notEnabled,
	keys: notEnabled,
	iterate: notEnabled,
};

module.exports = stub;
