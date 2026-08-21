const path = require('path');
const pak = require('../package.json');

module.exports = api => {
  api.cache(true);
  return {
    presets: ['module:@react-native/babel-preset'],
    plugins: [
      [
        'module-resolver',
        {
          extensions: ['.js', '.ts', '.json', '.jsx', '.tsx'],
          alias: {
            // Subpaths primeiro (`.../dev`) — a raiz do source é o diretório de
            // `pak.source` ("src/index"), não o próprio arquivo de entrada.
            [`^${pak.name}/(.+)$`]: path.join(
              __dirname,
              '..',
              path.dirname(pak.source),
              '\\1'
            ),
            [pak.name]: path.join(__dirname, '..', pak.source),
          },
        },
      ],
      // Must be last: reanimated 4 worklets transform.
      'react-native-worklets/plugin',
    ],
  };
};