-- TonePilot's own Lightroom Classic plug-in: a localhost-only socket that serves the
-- eight actions the TonePilot engine needs, and nothing else. See ../README.md.
return {
    LrSdkVersion = 8.0,
    LrSdkMinimumVersion = 8.0,

    LrToolkitIdentifier = 'app.tonepilot.lightroom',
    LrPluginName = "TonePilot",

    VERSION = { major = 0, minor = 1, revision = 0, build = 0 },

    LrInitPlugin = 'Init.lua',
    -- Starts the plug-in when Lightroom launches. Lightroom only honours this when the
    -- plug-in also adds at least one menu item.
    LrForceInitPlugin = true,

    LrLibraryMenuItems = {
        { title = "TonePilot Connection Status", file = "MenuStatus.lua" },
    },
}
