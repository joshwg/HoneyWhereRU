// Expo's `name` sets the app label on every platform. Android launchers
// truncate long labels (~12 chars), so this overrides only Android's
// app_name string with a shorter home-screen label.
const { AndroidConfig, withStringsXml } = require('expo/config-plugins');

module.exports = function withAndroidLabel(config, label) {
  return withStringsXml(config, (cfg) => {
    cfg.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: 'app_name', value: label })],
      cfg.modResults
    );
    return cfg;
  });
};
