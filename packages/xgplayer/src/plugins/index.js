
import '../skin/style/variable.scss'
import Poster from './poster'
import Replay from './replay'
import StartPlugin from './StartPlugin'
import Control from './controls'
/**
 * 根据入参的播放器配置进行默认plugin列表的配置
 * @param {object} playerConfig
 */
export default function getDefaultPlugins (playerConfig, Player) {
  const defaultPlugins = []
  defaultPlugins.push(Control)
  defaultPlugins.push(Replay)
  defaultPlugins.push(Poster)
  defaultPlugins.push(StartPlugin)
  const plugins = playerConfig.plugins || []
  const retPlugins = defaultPlugins.concat(plugins)
  return retPlugins
}
