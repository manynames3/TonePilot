local LrDialogs = import 'LrDialogs'

local state = _G.TonePilotBridgeState or {}
local lines = {
    "Running: " .. tostring(state.running == true),
    "Engine connected: " .. tostring(state.receiveConnected == true and state.sendConnected == true),
    "Requests handled: " .. tostring(state.requests or 0),
    "",
    "Recent events:",
}
for _, line in ipairs(state.log or {}) do lines[#lines + 1] = "  " .. line end

LrDialogs.message("TonePilot", table.concat(lines, "\n"), "info")
