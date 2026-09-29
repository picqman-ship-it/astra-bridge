// mcp-commander-ax: the macOS Accessibility helper behind the GUI tools (src/tools/gui.ts).
//
// One command per process: `mcp-commander-ax <command>`, a JSON request on stdin, exactly one JSON
// object on stdout ({"ok":true,...} or {"ok":false,"code":...,"message":...}). The Node side picks
// apps, windows and elements; this helper only reads the Accessibility tree and performs AXPress or
// sets AXValue on an element named by window + path. It never synthesizes mouse or keyboard events
// and never clicks at coordinates.
//
// Commands:
//   check    -> whether this process is trusted for Accessibility (no AX calls)
//   apps     -> regular (Dock) apps from NSWorkspace (no Accessibility permission needed)
//   windows  -> AX windows of the given pids
//   tree     -> a bounded breadth-first scan of one window (or a subtree of it)
//   act      -> AXPress / set AXValue on one element, after re-checking its fingerprint
//
// Every AX message is bounded by AXUIElementSetMessagingTimeout, every scan by an element count,
// a depth and a time budget; the Node side additionally kills this process on its own timeout.

import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

func emit(_ obj: [String: Any]) -> Never {
  var o = obj
  if o["ok"] == nil { o["ok"] = true }
  let data = (try? JSONSerialization.data(withJSONObject: o, options: []))
    ?? Data("{\"ok\":false,\"code\":\"internal\",\"message\":\"result could not be serialized\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

func fail(_ code: String, _ message: String, _ extra: [String: Any] = [:]) -> Never {
  var o = extra
  o["ok"] = false
  o["code"] = code
  o["message"] = message
  emit(o)
}

func axErrorName(_ e: AXError) -> String {
  switch e {
  case .success: return "success"
  case .failure: return "failure"
  case .illegalArgument: return "illegalArgument"
  case .invalidUIElement: return "invalidUIElement"
  case .invalidUIElementObserver: return "invalidUIElementObserver"
  case .cannotComplete: return "cannotComplete"
  case .attributeUnsupported: return "attributeUnsupported"
  case .actionUnsupported: return "actionUnsupported"
  case .notificationUnsupported: return "notificationUnsupported"
  case .notImplemented: return "notImplemented"
  case .notificationAlreadyRegistered: return "notificationAlreadyRegistered"
  case .notificationNotRegistered: return "notificationNotRegistered"
  case .apiDisabled: return "apiDisabled"
  case .noValue: return "noValue"
  case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
  case .notEnoughPrecision: return "notEnoughPrecision"
  @unknown default: return "axError(\(e.rawValue))"
  }
}

func failAX(_ e: AXError, _ doing: String) -> Never {
  switch e {
  case .apiDisabled:
    fail("not_trusted", "Accessibility access is not granted to this process (\(doing)).")
  case .cannotComplete:
    fail("app_not_responding", "The app did not answer within the Accessibility timeout (\(doing)).")
  case .invalidUIElement:
    fail("element_not_found", "The UI element no longer exists (\(doing)).")
  default:
    fail("ax_error", "Accessibility call failed with \(axErrorName(e)) (\(doing)).", ["axError": axErrorName(e)])
  }
}

// MARK: - Request

let argv = CommandLine.arguments
guard argv.count >= 2 else { fail("bad_request", "usage: mcp-commander-ax <check|apps|windows|tree|act> < request.json") }
let command = argv[1]
let stdinData = FileHandle.standardInput.readDataToEndOfFile()
var req: [String: Any] = [:]
if !stdinData.isEmpty {
  guard let parsed = (try? JSONSerialization.jsonObject(with: stdinData)) as? [String: Any] else {
    fail("bad_request", "stdin is not a JSON object")
  }
  req = parsed
}

func reqInt(_ k: String, _ def: Int, _ lo: Int, _ hi: Int) -> Int {
  guard let n = req[k] as? NSNumber else { return def }
  return max(lo, min(hi, n.intValue))
}

func reqBool(_ k: String, _ def: Bool) -> Bool {
  (req[k] as? NSNumber)?.boolValue ?? def
}

let budgetMs = reqInt("budgetMs", 10_000, 200, 120_000)
let deadline = Date().addingTimeInterval(Double(budgetMs) / 1000)
func timeLeft() -> Bool { Date() < deadline }

let maxText = reqInt("maxValueChars", 200, 16, 10_000)
let axTimeout = Float(reqInt("axTimeoutMs", 2000, 200, 10_000)) / 1000
// On the system-wide element this sets the default timeout for every element of this process.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), axTimeout)

// MARK: - Apps that GUI mutations must never touch
// Keep in sync with PROTECTED_BUNDLE_IDS in src/gui/select.ts (the Node side refuses first; this
// is the last line of defence against a crafted ref). Pressing buttons here could grant
// permissions (TCC), approve security prompts or read/alter credentials.
let protectedBundleIds: Set<String> = [
  "com.apple.systempreferences", "com.apple.SystemPreferences", "com.apple.settings.PrivacySecurity.extension",
  "com.apple.SecurityAgent", "com.apple.UserNotificationCenter", "com.apple.keychainaccess", "com.apple.Passwords",
  "com.apple.loginwindow", "com.apple.coreservices.uiagent", "com.apple.accessibility.universalAccessAuthWarn",
  "com.apple.ScreenSaver.Engine", "com.apple.Installer", "com.apple.DiskUtility", "com.apple.MigrateAssistant",
]

// MARK: - Attribute helpers

func copyAttr(_ el: AXUIElement, _ name: String) -> (CFTypeRef?, AXError) {
  var v: CFTypeRef?
  let e = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  return (e == .success ? v : nil, e)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? { copyAttr(el, name).0 }

func asString(_ v: CFTypeRef?) -> String? {
  guard let v = v else { return nil }
  let t = CFGetTypeID(v)
  if t == CFStringGetTypeID() { return (v as! CFString) as String }
  if t == CFAttributedStringGetTypeID() { return CFAttributedStringGetString((v as! CFAttributedString)) as String }
  if t == CFURLGetTypeID() { return CFURLGetString((v as! CFURL)) as String }
  return nil
}

func asBool(_ v: CFTypeRef?) -> Bool? {
  guard let v = v, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }
  return CFBooleanGetValue((v as! CFBoolean))
}

/** A JSON-safe scalar for an AXValue: text, number or boolean (anything else is not shown). */
func asScalar(_ v: CFTypeRef?) -> Any? {
  guard let v = v else { return nil }
  if let s = asString(v) { return s }
  if let b = asBool(v) { return b }
  if CFGetTypeID(v) == CFNumberGetTypeID() {
    let n = v as! NSNumber
    return n.doubleValue.isFinite ? n : nil
  }
  return nil
}

func truncate(_ s: String, _ max: Int = maxText) -> (String, Bool) {
  if s.count <= max { return (s, false) }
  return (String(s.prefix(max)), true)
}

func isAXErrorValue(_ v: AnyObject) -> Bool {
  CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError
}

/** Several attributes in one round trip. Missing attributes are simply absent. */
func multi(_ el: AXUIElement, _ names: [String]) -> ([String: CFTypeRef], AXError) {
  var out: [String: CFTypeRef] = [:]
  var values: CFArray?
  let e = AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
  if e == .success, let arr = values as? [AnyObject], arr.count == names.count {
    for (i, v) in arr.enumerated() where !isAXErrorValue(v) { out[names[i]] = v }
    return (out, .success)
  }
  // A dead or hung element must not cost one timeout per attribute.
  if e == .cannotComplete || e == .invalidUIElement || e == .apiDisabled { return (out, e) }
  for n in names { if let v = attr(el, n) { out[n] = v } }
  return (out, .success)
}

func actionNames(_ el: AXUIElement) -> [String] {
  var a: CFArray?
  guard AXUIElementCopyActionNames(el, &a) == .success, let names = a as? [String] else { return [] }
  return names
}

func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
  var s: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(el, name as CFString, &s) == .success && s.boolValue
}

/** Path steps use the role with anything outside [A-Za-z0-9_] replaced, so paths stay parseable. */
func pathRole(_ role: String?) -> String {
  guard let r = role, !r.isEmpty else { return "AXUnknown" }
  var out = ""
  for u in r.unicodeScalars.prefix(64) {
    let c = u.value
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95
    out.append(ok ? Character(u) : "_")
  }
  return out
}

func fnv(_ s: String) -> String {
  var h: UInt32 = 0x811c_9dc5
  for b in s.utf8 {
    h ^= UInt32(b)
    h = h &* 0x0100_0193
  }
  return String(format: "%08x", h)
}

/**
 * Identity of an element for stale-ref detection: role, subrole, identifier, title, description.
 * Deliberately not the value (text fields change it) nor the position.
 */
func fingerprint(_ a: [String: CFTypeRef]) -> String {
  let parts = ["AXRole", "AXSubrole", "AXIdentifier", "AXTitle", "AXDescription"].map { asString(a[$0]) ?? "" }
  return fnv(parts.joined(separator: "\u{1f}"))
}

let IDENTITY_ATTRS = ["AXRole", "AXSubrole", "AXIdentifier", "AXTitle", "AXDescription"]
let INFO_ATTRS = IDENTITY_ATTRS + ["AXEnabled", "AXFocused", "AXPlaceholderValue"]

func isSecure(_ a: [String: CFTypeRef]) -> Bool {
  asString(a["AXSubrole"]) == "AXSecureTextField" || asString(a["AXRole"]) == "AXSecureTextField"
}

/** Children, fetching at most `limit` of them; `total` is the element's real child count. */
func childElements(_ el: AXUIElement, limit: Int) -> (kids: [AXUIElement], total: Int) {
  var count: CFIndex = 0
  let ce = AXUIElementGetAttributeValueCount(el, "AXChildren" as CFString, &count)
  if ce == .success {
    if count <= 0 { return ([], 0) }
    var v: CFArray?
    if AXUIElementCopyAttributeValues(el, "AXChildren" as CFString, 0, min(count, limit), &v) == .success,
       let arr = v as? [AXUIElement] {
      return (arr, count)
    }
  }
  if ce == .cannotComplete || ce == .invalidUIElement { return ([], 0) }
  guard let arr = attr(el, "AXChildren") as? [AXUIElement] else { return ([], 0) }
  return (Array(arr.prefix(limit)), arr.count)
}

// MARK: - Apps and windows

typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> AXError
/// _AXUIElementGetWindow (HIServices SPI, present since 10.x) maps an AX window to its CGWindowID,
/// which is stable for the window's lifetime. Looked up at runtime: when absent we fall back to
/// index + title hash.
let getWindowFn: GetWindowFn? = {
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
  return unsafeBitCast(sym, to: GetWindowFn.self)
}()

func windowNumber(_ w: AXUIElement) -> Int? {
  guard let f = getWindowFn else { return nil }
  var id: UInt32 = 0
  return f(w, &id) == .success && id != 0 ? Int(id) : nil
}

func regularApps() -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
}

func appWindows(_ pid: pid_t) -> ([AXUIElement], AXError) {
  let (v, e) = copyAttr(AXUIElementCreateApplication(pid), "AXWindows")
  if e == .noValue { return ([], .success) }
  if e != .success { return ([], e) }
  // Placeholders (the application element itself, seen while the session is locked) are no windows.
  let wins = ((v as? [AXUIElement]) ?? []).filter { asString(attr($0, "AXRole")) != "AXApplication" }
  return (wins, .success)
}

func windowInfo(_ pid: pid_t, _ index: Int, _ w: AXUIElement) -> [String: Any] {
  let (a, _) = multi(w, ["AXTitle", "AXIdentifier", "AXRole", "AXSubrole", "AXMain", "AXFocused", "AXMinimized", "AXModal", "AXDocument"])
  let fullTitle = asString(a["AXTitle"]) ?? ""
  var o: [String: Any] = ["pid": Int(pid), "index": index, "title": truncate(fullTitle, 300).0, "titleFp": fnv(fullTitle)]
  o["windowId"] = windowNumber(w) ?? NSNull()
  for (k, attrName) in [("identifier", "AXIdentifier"), ("role", "AXRole"), ("subrole", "AXSubrole"), ("document", "AXDocument")] {
    if let s = asString(a[attrName]), !s.isEmpty { o[k] = truncate(s, 500).0 }
  }
  for (k, attrName) in [("main", "AXMain"), ("focused", "AXFocused"), ("minimized", "AXMinimized"), ("modal", "AXModal")] {
    if let b = asBool(a[attrName]) { o[k] = b }
  }
  return o
}

func requireApp(_ pid: pid_t, mutating: Bool) -> NSRunningApplication {
  guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else {
    fail("app_not_found", "No running app with pid \(pid) (it quit or was relaunched). Run list_windows again.")
  }
  if mutating {
    guard app.activationPolicy == .regular else {
      fail("protected_app", "pid \(pid) is not a regular app; GUI actions only target regular apps.")
    }
    if let b = app.bundleIdentifier, protectedBundleIds.contains(b) {
      fail("protected_app", "\(b) is protected: GUI actions never operate security or settings apps.")
    }
  }
  return app
}

/** The window named by `desc`: {windowId} or {index, titleFp}. Exactly one must match. */
func resolveWindow(_ pid: pid_t, _ desc: [String: Any]) -> (AXUIElement, Int) {
  let (wins, e) = appWindows(pid)
  if e != .success { failAX(e, "reading the windows of pid \(pid)") }
  var matches: [(AXUIElement, Int)] = []
  if let wid = (desc["windowId"] as? NSNumber)?.intValue {
    guard getWindowFn != nil else { fail("bad_request", "window ids are not available on this macOS version") }
    matches = wins.enumerated().filter { windowNumber($0.element) == wid }.map { ($0.element, $0.offset) }
  } else if let idx = (desc["index"] as? NSNumber)?.intValue, let tfp = desc["titleFp"] as? String {
    if idx >= 0 && idx < wins.count && fnv(asString(attr(wins[idx], "AXTitle")) ?? "") == tfp { matches = [(wins[idx], idx)] }
  } else {
    fail("bad_request", "window must be {windowId} or {index, titleFp}")
  }
  if matches.isEmpty {
    fail("window_not_found", "The window is gone or changed (closed, retitled or reordered). Run list_windows / inspect_ui again.")
  }
  if matches.count > 1 { fail("window_ambiguous", "\(matches.count) windows match; nothing was done.") }
  return matches[0]
}

func parseStep(_ s: Substring) -> (String, Int)? {
  guard s.hasSuffix("]"), let open = s.lastIndex(of: "[") else { return nil }
  let role = String(s[s.startIndex..<open])
  guard !role.isEmpty, let n = Int(s[s.index(after: open)..<s.index(before: s.endIndex)]), n >= 0 else { return nil }
  return (role, n)
}

/** Follows "Role[n]/Role[n]/…" (n = index among siblings with that role) from `root`. */
func resolvePath(_ root: AXUIElement, _ path: String) -> AXUIElement {
  if path.isEmpty { return root }
  var cur = root
  for (i, seg) in path.split(separator: "/", omittingEmptySubsequences: false).enumerated() {
    guard let (role, n) = parseStep(seg) else { fail("bad_request", "invalid path step \"\(seg)\"") }
    if !timeLeft() { fail("timeout", "time budget exhausted while resolving the element path") }
    let (kids, _) = childElements(cur, limit: 10_000)
    var seen = 0
    var found: AXUIElement?
    for k in kids where pathRole(asString(attr(k, "AXRole"))) == role {
      if seen == n { found = k; break }
      seen += 1
    }
    guard let f = found else {
      fail("element_not_found", "Path step \(i + 1) (\(seg)) no longer exists: the UI changed. Run inspect_ui again.")
    }
    cur = f
  }
  return cur
}

// MARK: - Element description

func describe(_ el: AXUIElement, includeValue: Bool) -> (node: [String: Any], attrs: [String: CFTypeRef], error: AXError) {
  let (a, err) = multi(el, INFO_ATTRS)
  var node: [String: Any] = ["role": asString(a["AXRole"]) ?? "AXUnknown", "fp": fingerprint(a)]
  if err != .success { node["error"] = axErrorName(err); return (node, a, err) }
  for (k, attrName) in [("subrole", "AXSubrole"), ("title", "AXTitle"), ("description", "AXDescription"),
                        ("identifier", "AXIdentifier"), ("placeholder", "AXPlaceholderValue")] {
    if let s = asString(a[attrName]), !s.isEmpty { node[k] = truncate(s).0 }
  }
  if let b = asBool(a["AXEnabled"]) { node["enabled"] = b }
  if let b = asBool(a["AXFocused"]) { node["focused"] = b }
  let actions = actionNames(el)
  if !actions.isEmpty { node["actions"] = Array(actions.prefix(12)) }
  let secure = isSecure(a)
  if secure {
    node["secure"] = true // its value is never read
    node["settable"] = isSettable(el, "AXValue")
  } else {
    let (v, ve) = copyAttr(el, "AXValue")
    if ve == .success || ve == .noValue { node["settable"] = isSettable(el, "AXValue") }
    if includeValue, let scalar = asScalar(v) {
      if let s = scalar as? String {
        let (t, cut) = truncate(s)
        node["value"] = t
        if cut { node["valueTruncated"] = true; node["valueLength"] = s.count }
      } else {
        node["value"] = scalar
      }
    }
  }
  return (node, a, .success)
}

// MARK: - Commands

/// Screen lock / fast-user-switch state. While either holds, macOS hands out placeholder elements
/// (AXWindows answers with the application element), so every AX command refuses instead.
func sessionState() -> (locked: Bool, onConsole: Bool) {
  let d = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
  let locked = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
  let onConsole = (d[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue ?? true
  return (locked, onConsole)
}

func cmdCheck() -> Never {
  let s = sessionState()
  emit(["trusted": AXIsProcessTrusted(), "windowIdSupported": getWindowFn != nil, "pid": Int(getpid()),
        "screenLocked": s.locked, "onConsole": s.onConsole])
}

func cmdApps() -> Never {
  let apps: [[String: Any]] = regularApps().map { app in
    var o: [String: Any] = ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "", "active": app.isActive, "hidden": app.isHidden]
    o["bundleId"] = app.bundleIdentifier ?? NSNull()
    return o
  }
  emit(["apps": apps])
}

func requireTrusted() {
  if !AXIsProcessTrusted() {
    fail("not_trusted", "Accessibility access is not granted to the process that runs this server.")
  }
  let s = sessionState()
  if s.locked {
    fail("screen_locked", "The Mac's screen is locked; macOS does not expose app windows to Accessibility while it is locked. Retry after the owner unlocks it.")
  }
  if !s.onConsole {
    fail("session_inactive", "This user's session is not the active console session (another user is switched in), so app windows are not reachable.")
  }
}

func cmdWindows() -> Never {
  requireTrusted()
  let pids: [pid_t] = (req["pids"] as? [NSNumber])?.map { pid_t($0.int32Value) } ?? regularApps().map { $0.processIdentifier }
  let maxWindows = reqInt("maxWindows", 200, 1, 2000)
  var windows: [[String: Any]] = []
  var errors: [[String: Any]] = []
  var complete = true
  outer: for pid in pids {
    if !timeLeft() { complete = false; break }
    let (wins, e) = appWindows(pid)
    if e != .success {
      if e == .apiDisabled { fail("not_trusted", "Accessibility access is not granted to the process that runs this server.") }
      errors.append(["pid": Int(pid), "error": e == .cannotComplete ? "not responding" : axErrorName(e)])
      continue
    }
    for (i, w) in wins.enumerated() {
      if windows.count >= maxWindows || !timeLeft() { complete = false; break outer }
      windows.append(windowInfo(pid, i, w))
    }
  }
  emit(["windows": windows, "errors": errors, "complete": complete])
}

func cmdTree() -> Never {
  requireTrusted()
  guard let pidN = req["pid"] as? NSNumber else { fail("bad_request", "pid is required") }
  let pid = pid_t(pidN.int32Value)
  _ = requireApp(pid, mutating: false)
  let (window, windowIndex) = resolveWindow(pid, req["window"] as? [String: Any] ?? [:])
  let rootPath = req["root"] as? String ?? ""
  let root = resolvePath(window, rootPath)
  let maxDepth = reqInt("maxDepth", 10, 0, 64)
  let maxElements = reqInt("maxElements", 400, 1, 5000)
  let maxChildren = reqInt("maxChildren", 300, 1, 5000)
  let includeValues = reqBool("includeValues", true)

  var nodes: [[String: Any]] = []
  var complete = true
  var stopReason: String?
  // Breadth-first so a big first subtree (a toolbar, a long list) cannot use up the whole budget.
  var queue: [(el: AXUIElement, path: String, order: [Int], depth: Int)] = [(root, rootPath, [], 0)]
  var head = 0
  while head < queue.count {
    if !timeLeft() { complete = false; stopReason = "time budget"; break }
    let item = queue[head]
    head += 1
    var (node, attrs, err) = describe(item.el, includeValue: includeValues)
    node["path"] = item.path
    node["order"] = item.order
    node["depth"] = item.depth
    if let expected = req["rootFp"] as? String, item.depth == 0, node["fp"] as? String != expected {
      fail("stale_ref", "The element at this ref changed (now \(node["role"] ?? "?") \(asString(attrs["AXTitle"]) ?? "")). Run inspect_ui again.")
    }
    if err == .apiDisabled { failAX(err, "reading the UI tree") }
    if err == .success {
      let (kids, total) = childElements(item.el, limit: maxChildren)
      if total > 0 { node["childCount"] = total }
      if item.depth >= maxDepth {
        if total > 0 { node["childrenOmitted"] = total; complete = false; stopReason = stopReason ?? "depth limit" }
      } else {
        var counts: [String: Int] = [:]
        var queued = 0
        for (i, k) in kids.enumerated() {
          if queue.count >= maxElements { complete = false; stopReason = stopReason ?? "element limit"; break }
          let r = pathRole(asString(attr(k, "AXRole")))
          let n = counts[r, default: 0]
          counts[r] = n + 1
          let step = "\(r)[\(n)]"
          queue.append((k, item.path.isEmpty ? step : "\(item.path)/\(step)", item.order + [i], item.depth + 1))
          queued += 1
        }
        if queued < total {
          node["childrenOmitted"] = total - queued
          complete = false
          if stopReason == nil { stopReason = total > maxChildren ? "children per element limit" : "element limit" }
        }
      }
    }
    nodes.append(node)
  }
  if head < queue.count { complete = false }
  var out: [String: Any] = ["window": windowInfo(pid, windowIndex, window), "nodes": nodes, "complete": complete, "scanned": nodes.count]
  if let r = stopReason { out["stopReason"] = r }
  emit(out)
}

func observe(_ el: AXUIElement) -> [String: Any] {
  let (a, e) = multi(el, IDENTITY_ATTRS + ["AXEnabled", "AXFocused"])
  if e == .invalidUIElement || a["AXRole"] == nil { return ["exists": false] }
  var o: [String: Any] = ["exists": true]
  if let s = asString(a["AXTitle"]) { o["title"] = truncate(s).0 }
  if let b = asBool(a["AXEnabled"]) { o["enabled"] = b }
  if let b = asBool(a["AXFocused"]) { o["focused"] = b }
  if !isSecure(a), let v = asScalar(attr(el, "AXValue")) {
    if let s = v as? String { o["value"] = truncate(s).0; o["valueLength"] = s.count } else { o["value"] = v }
  }
  return o
}

func stillExists(_ el: AXUIElement) -> Bool {
  copyAttr(el, "AXRole").1 != .invalidUIElement
}

func cmdAct() -> Never {
  requireTrusted()
  guard let pidN = req["pid"] as? NSNumber else { fail("bad_request", "pid is required") }
  let pid = pid_t(pidN.int32Value)
  _ = requireApp(pid, mutating: true)
  let (window, _) = resolveWindow(pid, req["window"] as? [String: Any] ?? [:])
  let el = resolvePath(window, req["path"] as? String ?? "")
  let (a, err) = multi(el, IDENTITY_ATTRS)
  if err != .success { failAX(err, "reading the target element") }
  guard let expected = req["fp"] as? String else { fail("bad_request", "fp is required") }
  let fp = fingerprint(a)
  if fp != expected {
    fail("stale_ref", "The element at this path is no longer the one that was inspected (now \(asString(a["AXRole"]) ?? "?") \"\(asString(a["AXTitle"]) ?? "")\"). Nothing was done. Run inspect_ui again.")
  }
  let settleMs = reqInt("settleMs", 300, 0, 5000)

  switch req["action"] as? String {
  case "press":
    let actions = actionNames(el)
    guard actions.contains("AXPress") else {
      fail("not_actionable", "The element does not support AXPress. Nothing was done.", ["actions": actions])
    }
    let before = observe(el)
    let e = AXUIElementPerformAction(el, "AXPress" as CFString)
    if e == .cannotComplete {
      fail("outcome_unknown", "The app did not confirm AXPress within the Accessibility timeout; the press may or may not have happened.")
    }
    if e != .success { failAX(e, "performing AXPress") }
    if settleMs > 0 { usleep(useconds_t(settleMs * 1000)) }
    emit(["action": "press", "performed": true, "before": before, "after": observe(el), "windowExists": stillExists(window)])

  case "setValue":
    guard let value = req["value"] as? String else { fail("bad_request", "value (string) is required") }
    if isSecure(a) {
      fail("secure_field", "Refusing to set a secure (password) text field. Nothing was done.")
    }
    guard isSettable(el, "AXValue") else {
      fail("not_settable", "The element's AXValue is not settable. Nothing was done.")
    }
    let (current, _) = copyAttr(el, "AXValue")
    if current != nil && asString(current) == nil {
      fail("unsupported_value_type", "The element's value is not text; this version only sets text values. Nothing was done.")
    }
    let before = observe(el)
    let e = AXUIElementSetAttributeValue(el, "AXValue" as CFString, value as CFString)
    if e == .cannotComplete {
      fail("outcome_unknown", "The app did not confirm the new value within the Accessibility timeout; it may or may not have been set.")
    }
    if e != .success { failAX(e, "setting AXValue") }
    if settleMs > 0 { usleep(useconds_t(settleMs * 1000)) }
    let readBack = asString(attr(el, "AXValue"))
    var out: [String: Any] = ["action": "setValue", "performed": true, "verified": readBack == value, "before": before,
                              "windowExists": stillExists(window)]
    if let r = readBack {
      out["readBack"] = truncate(r).0
      out["readBackLength"] = r.count
    } else {
      out["readBack"] = NSNull()
    }
    emit(out)

  default:
    fail("bad_request", "action must be \"press\" or \"setValue\"")
  }
}

switch command {
case "check": cmdCheck()
case "apps": cmdApps()
case "windows": cmdWindows()
case "tree": cmdTree()
case "act": cmdAct()
default: fail("bad_request", "unknown command \(command)")
}
