var _get = function get(object, property, receiver) { if (object === null) object = Function.prototype; var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { return get(parent, property, receiver); } } else if ("value" in desc) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } };

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

import Player from 'xgplayer';
import Context from 'xgplayer-transmuxer-context';
import Core from './raw-264';
import Events from 'xgplayer-transmuxer-constant-events';
import LoaderBuffer from 'xgplayer-transmuxer-buffer-xgbuffer';
import FetchLoader from 'xgplayer-transmuxer-loader-fetch';
import 'xgplayer-mobilevideo';

var asmSupported = function asmSupported() {
  try {
    (function MyAsmModule() {
      'use asm';
    })();
    return true;
  } catch (err) {
    // will never show...
    return false;
  }
};

var Raw264Player = function (_Player) {
  _inherits(Raw264Player, _Player);

  _createClass(Raw264Player, null, [{
    key: 'isSupported',
    value: function isSupported() {
      var wasmSupported = 'WebAssembly' in window;

      var WebComponentSupported = 'customElements' in window && window.customElements.define;
      var isComponentDefined = void 0;
      if (WebComponentSupported) {
        isComponentDefined = window.customElements.get('mobile-video');
      }
      return (wasmSupported || asmSupported) && isComponentDefined;
    }
  }]);

  function Raw264Player(props) {
    _classCallCheck(this, Raw264Player);

    if (!props.mediaType) {
      props.mediaType = 'mobile-video';
      if (props.videoConfig) {
        props.videoConfig.preloadtime = props.preloadTime || 5;
      } else {
        props.videoConfig = {
          preloadtime: props.preloadTime || 5
        };
      }
    }

    var _this = _possibleConstructorReturn(this, (Raw264Player.__proto__ || Object.getPrototypeOf(Raw264Player)).call(this, props));

    _this.video.setAttribute('noaudio', true);
    _this.handleTimeupdate = _this.handleTimeupdate.bind(_this);
    _this.hasPlayed = false;
    _this.hasStart = false;
    return _this;
  }

  _createClass(Raw264Player, [{
    key: 'start',
    value: function start() {
      if (this.hasStart) {
        return;
      } else {
        this.hasStart = true;
      }
      this.context = new Context(Events.HlsAllowedEvents);
      this.context.registry('LOADER_BUFFER', LoaderBuffer);
      this.core = this.context.registry('RAW_264_CONTROLLER', Core)({ player: this, fps: this.config.fps });
      this.context.registry('FETCH_LOADER', FetchLoader);
      this.context.init();
      if (!this.config.isLive) {
        this.core.load(this.config.url);
      }

      _get(Raw264Player.prototype.__proto__ || Object.getPrototypeOf(Raw264Player.prototype), 'start', this).call(this);
      this.video.preloadTime = this.config.preloadTime;
      this.video.addEventListener('timeupdate', this.handleTimeupdate, false);
    }
  }, {
    key: 'replay',
    value: function replay() {
      this.video._cleanBuffer();
      this.currentTime = 0;
      this.start();
      this.play();
    }
  }, {
    key: 'handleTimeupdate',
    value: function handleTimeupdate() {
      if (!this.config.isLive && this.currentTime >= this.duration) {
        this.video._cleanBuffer();
        this.pause();
        this.emit('ended');
      } else if (this.config.isLive && this.buffered.end(0) - this.currentTime > 0.1) {
        this.currentTime = this.buffered.end(0) - 0.1;
      }
    }
  }, {
    key: 'destroy',
    value: function destroy(isDelDom) {
      _get(Raw264Player.prototype.__proto__ || Object.getPrototypeOf(Raw264Player.prototype), 'destroy', this).call(this, isDelDom);
      this.core.destroy();
      this.context.destroy();
      this.core = null;
      this.context = null;
    }
  }, {
    key: 'pushBuffer',
    value: function pushBuffer(arr) {
      if (!this.hasStart) {
        return this.start();
      }
      if (this.buffer) {
        this.buffer.push(arr);
        this.core.handleDataLoaded();
      }
    }
  }, {
    key: 'buffer',
    get: function get() {
      return this.context.getInstance('LOADER_BUFFER');
    }
  }, {
    key: 'currentTime',
    set: function set(time) {
      var oldTime = _get(Raw264Player.prototype.__proto__ || Object.getPrototypeOf(Raw264Player.prototype), 'currentTime', this);
      var buffered = this.getBufferedRange();
      if (buffered[0] <= time && buffered[1] >= time) {
        this.video.currentTime = time;
      } else {
        this.video.currentTime = oldTime;
      }
    },
    get: function get() {
      return _get(Raw264Player.prototype.__proto__ || Object.getPrototypeOf(Raw264Player.prototype), 'currentTime', this);
    }
  }, {
    key: 'duration',
    get: function get() {
      if (this.core && this.core.duration) {
        return this.core.duration;
      }
      return this.video.duration;
    }
  }]);

  return Raw264Player;
}(Player);

export default Raw264Player;