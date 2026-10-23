local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local Server = require 'Server'

-- A context of its own: a bare startAsyncTask would be cancelled when this init
-- script returns.
LrFunctionContext.postAsyncTaskWithContext("TonePilotServer", function(context)
    LrTasks.sleep(0.5)   -- let a previous instance (Reload Plug-in) release its ports
    local ok, err = LrTasks.pcall(Server.run, context)
    if not ok then Server.log("Server stopped: " .. tostring(err)) end
end)
