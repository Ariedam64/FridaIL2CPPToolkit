/* Disk persistence stub. Implemented in M3 (bookmarks) and M5 (dumps). */
function listBookmarks() { throw new Error("persistence.listBookmarks: implemented in M3"); }
function getBookmark(_name) { throw new Error("persistence.getBookmark: implemented in M3"); }
function saveBookmark(_name, _data) { throw new Error("persistence.saveBookmark: implemented in M3"); }
function deleteBookmark(_name) { throw new Error("persistence.deleteBookmark: implemented in M3"); }
function saveDump(_payload, _meta) { throw new Error("persistence.saveDump: implemented in M5"); }

module.exports = { listBookmarks, getBookmark, saveBookmark, deleteBookmark, saveDump };
