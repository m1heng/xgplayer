/**
 * highly optimized TS demuxer:
 * parse PAT, PMT
 * extract PES packet from audio and video PIDs
 * extract AVC/H264 NAL units and AAC/ADTS samples from PES packet
 * trigger the remuxer upon parsing completion
 * it also tries to workaround as best as it can audio codec switch (HE-AAC to AAC and vice versa), without having to restart the MediaSource.
 * it also controls the remuxing process :
 * upon discontinuity or level switch detection, it will also notifies the remuxer so that it can reset its state.
*/

 import ADTS from './adts';
 import Event from '../events';
 import ExpGolomb from './exp-golomb';
 import HEVCSpsParser from './hevc-sps-parser';
// import Hex from '../utils/hex';
 import {logger} from '../utils/logger';
 import {ErrorTypes, ErrorDetails} from '../errors';

 class TSDemuxer {

  constructor(observer, id, remuxerClass, config) {
    this.observer = observer;
    this.id = id;
    this.remuxerClass = remuxerClass;
    this.config = config;
    this.lastCC = 0;
    this.remuxer = new this.remuxerClass(observer, id, config);
    this.HEVC = 0x24;
    this.AVC = 0x1b;
  }

  static probe(data) {
    // a TS fragment should contain at least 3 TS packets, a PAT, a PMT, and one PID, each starting with 0x47
    if (data.length >= 3*188 && data[0] === 0x47 && data[188] === 0x47 && data[2*188] === 0x47) {
      return true;
    } else {
      return false;
    }
  }

  switchLevel() {
    this.pmtParsed = false;
    this._pmtId = -1;
    // codec HEVC = 0x24, AVC = 0x1b
    this._videoTrack = {container : 'video/mp2t', type: 'video', streamType: -1, PID : -1, sequenceNumber: 0, samples : [], len : 0, nbNalu : 0, dropped : 0};
    this._aacTrack = {container : 'video/mp2t', type: 'audio', id :-1, sequenceNumber: 0, samples : [], len : 0};
    this._id3Track = {type: 'id3', id :-1, sequenceNumber: 0, samples : [], len : 0};
    this._txtTrack = {type: 'text', id: -1, sequenceNumber: 0, samples: [], len: 0};
    // flush any partial content
    this.aacOverFlow = null;
    this.aacLastPTS = null;
    this.avcNaluState = 0;
    this.remuxer.switchLevel();
  }

  insertDiscontinuity() {
    this.switchLevel();
    this.remuxer.insertDiscontinuity();
  }

  // feed incoming data to the front of the parsing pipeline
  push(data, audioCodec, videoCodec, timeOffset, cc, level, sn, duration) {
    let videoData, aacData, id3Data,
        start, len = data.length, stt, pid, atf, offset,
        codecsOnly = this.remuxer.passthrough,
        unknownPIDs = false;

    this.audioCodec = audioCodec;
    this.videoCodec = videoCodec;
    this.timeOffset = timeOffset;
    this._duration = duration;
    this.contiguous = false;
    if (cc !== this.lastCC) {
      logger.log('discontinuity detected');
      this.insertDiscontinuity();
      this.lastCC = cc;
    }
    if (level !== this.lastLevel) {
      logger.log('level switch detected');
      this.switchLevel();
      this.lastLevel = level;
    } else if (sn === (this.lastSN+1)) {
      this.contiguous = true;
    }
    this.lastSN = sn;

    var pmtParsed = this.pmtParsed,
        videoPID = this._videoTrack.PID,
        videoStreamType = this._videoTrack.streamType,
        aacId = this._aacTrack.id,
        id3Id = this._id3Track.id,
        pmtId = this._pmtId;

    var parsePAT = this._parsePAT,
        parsePMT = this._parsePMT,
        parsePES = this._parsePES,
        parseHEVCPES = this._parseHEVCPES.bind(this),
        parseAVCPES = this._parseAVCPES.bind(this),
        parseAACPES = this._parseAACPES.bind(this),
        parseID3PES  = this._parseID3PES.bind(this);

    // don't parse last TS packet if incomplete
    len -= len % 188;
    // loop through TS packets
    for (start = 0; start < len; start += 188) {
      if (data[start] === 0x47) {
        stt = !!(data[start + 1] & 0x40);
        // pid is a 13-bit field starting at the last bit of TS[1]
        pid = ((data[start + 1] & 0x1f) << 8) + data[start + 2];
        atf = (data[start + 3] & 0x30) >> 4;
        // if an adaption field is present, its length is specified by the fifth byte of the TS packet header.
        if (atf > 1) {
          offset = start + 5 + data[start + 4];
          // continue if there is only adaptation field
          if (offset === (start + 188)) {
            continue;
          }
        } else {
          offset = start + 4;
        }
        switch(pid) {
          case videoPID:
            if (stt) {
              if (videoData) {
                var pesData = parsePES(videoData);
                if(videoStreamType === this.HEVC) {
                  // console.log('videoStreamType === this.HEVC')
                  parseHEVCPES(pesData);
                }
                else if(videoStreamType === this.AVC) {
                  // console.log('videoStreamType === this.AVC')
                  parseAVCPES(pesData);
                }
                else {
                  logger.error('unsupported video stream type');
                  return;
                }

                if (codecsOnly) {
                  // if we have video codec info AND
                  // if audio PID is undefined OR if we have audio codec info,
                  // we have all codec info !
                  if (this._videoTrack.codec && (aacId === -1 || this._aacTrack.codec)) {
                    this.remux(level,sn,data);
                    return;
                  }
                }
              }
              videoData = {data: [], size: 0};
            }
            if (videoData) {
              videoData.data.push(data.subarray(offset, start + 188));
              videoData.size += start + 188 - offset;
            }
            break;
          case aacId:
            if (stt) {
              if (aacData) {
                parseAACPES(parsePES(aacData));
                if (codecsOnly) {
                  // here we now that we have audio codec info
                  // if video PID is undefined OR if we have video codec info,
                  // we have all codec infos !
                  if (this._aacTrack.codec && (videoPID === -1 || this._videoTrack.codec)) {
                    this.remux(level,sn,data);
                    return;
                  }
                }
              }
              aacData = {data: [], size: 0};
            }
            if (aacData) {
              aacData.data.push(data.subarray(offset, start + 188));
              aacData.size += start + 188 - offset;
            }
            break;
          case id3Id:
            if (stt) {
              if (id3Data) {
                parseID3PES(parsePES(id3Data));
              }
              id3Data = {data: [], size: 0};
            }
            if (id3Data) {
              id3Data.data.push(data.subarray(offset, start + 188));
              id3Data.size += start + 188 - offset;
            }
            break;
          case 0:
            if (stt) {
              offset += data[offset] + 1;
            }
            pmtId = this._pmtId = parsePAT(data, offset);
            break;
          case pmtId:
            if (stt) {
              offset += data[offset] + 1;
            }
            let parsedPIDs = parsePMT(data, offset);
            videoPID = this._videoTrack.PID = parsedPIDs.videoPID;
            videoStreamType = this._videoTrack.streamType = parsedPIDs.videoStreamType;
            aacId = this._aacTrack.id = parsedPIDs.aac;
            id3Id = this._id3Track.id = parsedPIDs.id3;
            if (unknownPIDs && !pmtParsed) {
              logger.log('reparse from beginning');
              unknownPIDs = false;
              // we set it to -188, the += 188 in the for loop will reset start to 0
              start = -188;
            }
            pmtParsed = this.pmtParsed = true;
            break;
          case 17:
          case 0x1fff:
            break;
          default:
            unknownPIDs = true;
            break;
        }
      } else {
        this.observer.trigger(Event.ERROR, {type : ErrorTypes.MEDIA_ERROR, id : this.id, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: false, reason: 'TS packet did not start with 0x47'});
      }
    }
    // parse last PES packet
    if (videoData) {
      var pes = parsePES(videoData);
      if(videoStreamType === this.HEVC) {
        parseHEVCPES(pes);
      }
      else if(videoStreamType === this.AVC) {
        parseAVCPES(pes);
      }
      else {
        logger.error('unsupported video stream type ' + videoStreamType);
      }
    }
    if (aacData) {
      parseAACPES(parsePES(aacData));
    }
    if (id3Data) {
      parseID3PES(parsePES(id3Data));
    }
    this.remux(level,sn,null);
  }

  remux(level, sn, data) {
    logger.log('tsdemuxer remux')
    this.remuxer.remux(level, sn, this._aacTrack, this._videoTrack, this._id3Track, this._txtTrack, this.timeOffset, this.contiguous, data);
  }

  destroy() {
    this.switchLevel();
    this._initPTS = this._initDTS = undefined;
    this._duration = 0;
  }

  _parsePAT(data, offset) {
    // skip the PSI header and parse the first PMT entry
    return (data[offset + 10] & 0x1F) << 8 | data[offset + 11];
    //logger.log('PMT PID:'  + this._pmtId);
  }

  _parsePMT(data, offset) {
    var sectionLength, tableEnd, programInfoLength, pid, result = { aac : -1, videoPID : -1, videoStreamType: -1, id3 : -1};
    sectionLength = (data[offset + 1] & 0x0f) << 8 | data[offset + 2];
    tableEnd = offset + 3 + sectionLength - 4;
    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (data[offset + 10] & 0x0f) << 8 | data[offset + 11];
    // advance the offset to the first entry in the mapping table
    offset += 12 + programInfoLength;
    while (offset < tableEnd) {
      pid = (data[offset + 1] & 0x1F) << 8 | data[offset + 2];
      var streamType  = data[offset];
      switch(streamType) {
        // ISO/IEC 13818-7 ADTS AAC (MPEG-2 lower bit-rate audio)
        case 0x0f:
          //logger.log('AAC PID:'  + pid);
          if (result.aac === -1) {
            result.aac = pid;
          }
          break;
        // Packetized metadata (ID3)
        case 0x15:
          //logger.log('ID3 PID:'  + pid);
          if (result.id3 === -1) {
            result.id3 = pid;
          }
          break;
        // HEVC
        case 0x24:
          if (result.videoPID === -1) {
            result.videoPID = pid;
            result.videoStreamType = streamType;
          }
          break;
        // ITU-T Rec. H.264 and ISO/IEC 14496-10 (lower bit-rate video)
        case 0x1b:
          if (result.videoPID === -1) {
            result.videoPID = pid;
            result.videoStreamType = streamType;
          }
          break;
        default:
        logger.log('unkown stream type:'  + streamType);
        break;
      }
      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((data[offset + 3] & 0x0F) << 8 | data[offset + 4]) + 5;
    }
    return result;
  }

  _parsePES(stream) {
    var i = 0, frag, pesFlags, pesPrefix, pesLen, pesHdrLen, pesData, pesPts, pesDts, payloadStartOffset, data = stream.data;
    //retrieve PTS/DTS from first fragment
    frag = data[0];
    // console.log('frag:', frag)
    pesPrefix = (frag[0] << 16) + (frag[1] << 8) + frag[2];
    if (pesPrefix === 1) {
      pesLen = (frag[4] << 8) + frag[5];
      pesFlags = frag[7];
      if (pesFlags & 0xC0) {
        /* PES header described here : http://dvd.sourceforge.net/dvdinfo/pes-hdr.html
            as PTS / DTS is 33 bit we cannot use bitwise operator in JS,
            as Bitwise operators treat their operands as a sequence of 32 bits */
        pesPts = (frag[9] & 0x0E) * 536870912 +// 1 << 29
          (frag[10] & 0xFF) * 4194304 +// 1 << 22
          (frag[11] & 0xFE) * 16384 +// 1 << 14
          (frag[12] & 0xFF) * 128 +// 1 << 7
          (frag[13] & 0xFE) / 2;
          // check if greater than 2^32 -1
          if (pesPts > 4294967295) {
            // decrement 2^33
            pesPts -= 8589934592;
          }
        if (pesFlags & 0x40) {
          pesDts = (frag[14] & 0x0E ) * 536870912 +// 1 << 29
            (frag[15] & 0xFF ) * 4194304 +// 1 << 22
            (frag[16] & 0xFE ) * 16384 +// 1 << 14
            (frag[17] & 0xFF ) * 128 +// 1 << 7
            (frag[18] & 0xFE ) / 2;
          // check if greater than 2^32 -1
          if (pesDts > 4294967295) {
            // decrement 2^33
            pesDts -= 8589934592;
          }
        } else {
          pesDts = pesPts;
        }
      }
      pesHdrLen = frag[8];
      payloadStartOffset = pesHdrLen + 9;

      stream.size -= payloadStartOffset;
      //reassemble PES packet
      pesData = new Uint8Array(stream.size);
      while (data.length) {
        frag = data.shift();
        var len = frag.byteLength;
        if (payloadStartOffset) {
          if (payloadStartOffset > len) {
            // trim full frag if PES header bigger than frag
            payloadStartOffset-=len;
            continue;
          } else {
            // trim partial frag if PES header smaller than frag
            frag = frag.subarray(payloadStartOffset);
            len-=payloadStartOffset;
            payloadStartOffset = 0;
          }
        }
        pesData.set(frag, i);
        i+=len;
      }
      // console.log('pesData:', pesData)
      // console.log(pesData)
      return {data: pesData, pts: pesPts, dts: pesDts, len: pesLen};
    } else {
      return null;
    }
  }

  _parseHEVCPES(pes) {
    let track = this._videoTrack,
        samples = track.samples,
        units = this._parseHEVCNALu(pes.data),
        units2 = [],
        debug = false,
        key = false,
        length = 0,
        // expGolombDecoder,
        avcSample,
        push;
        // i;
    // no NALu found
    if (units.length === 0 && samples.length > 0) {
      // append pes.data to previous NAL unit
      var lastavcSample = samples[samples.length - 1];
      var lastUnit = lastavcSample.units.units[lastavcSample.units.units.length - 1];
      var tmp = new Uint8Array(lastUnit.data.byteLength + pes.data.byteLength);
      tmp.set(lastUnit.data, 0);
      tmp.set(pes.data, lastUnit.data.byteLength);
      lastUnit.data = tmp;
      lastavcSample.units.length += pes.data.byteLength;
      track.len += pes.data.byteLength;
    }
    //free pes.data to save up some memory
    pes.data = null;
    var debugString = '';

    var pushAccesUnit = function() {
      if (units2.length) {
        // only push AVC sample if starting with a keyframe is not mandatory OR
        //    if keyframe already found in this fragment OR
        //       keyframe found in last fragment (track.sps) AND
        //          samples already appended (we already found a keyframe in this fragment) OR fragment is contiguous
        if (!this.config.forceKeyFrameOnDiscontinuity ||
            key === true ||
            (track.sps /*&& (samples.length || this.contiguous)*/))
        {
          avcSample = {units: { units : units2, length : length}, pts: pes.pts, dts: pes.dts, key: key};
          samples.push(avcSample);
          track.len += length;
          track.nbNalu += units2.length;
        } else {
          // dropped samples, track it
          track.dropped++;
        }
        units2 = [];
        length = 0;
      }
    }.bind(this);

    units.forEach(unit => {
      switch(unit.type) {
        case 0:
          push = true;
          if(debug) {
            debugString += 'SLICE_TRAIL_N ';
          }
          break;
        case 1:
          push = true;
          if(debug) {
            debugString += 'SLICE_TRAIL_R ';
          }
          key = true;
          break;
        case 2:
          push = true;
           if(debug) {
            debugString += 'SLICE_TSA_N ';
          }
          break;
        case 3:
          push = true;
          if(debug) {
            debugString += 'SLICE_TSA_R ';
          }
          key = true;
          break;
        case 4:
          push = true;
          if(debug) {
            debugString += 'SLICE_STSA_N ';
          }
          break;
        case 5:
          push = true;
          if(debug) {
            debugString += 'SLICE_STSA_R ';
          }
          key = true;
          break;
        case 6:
          push = true;
          if(debug) {
            debugString += 'SLICE_RADL_N ';
          }
          break;
        case 7:
          push = true;
          if(debug) {
            debugString += 'SLICE_RADL_R ';
          }
          key = true;
          break;
        case 8:
          push = true;
          if(debug) {
            debugString += 'SLICE_RASL_N ';
          }
          break;
        case 9:
          push = true;
          if(debug) {
            debugString += 'SLICE_RASL_R ';
          }
          key = true;
          break;
        case 16:
          push = true;
          if(debug) {
            debugString += 'SLICE_BLA_W_LP ';
          }
          break;
        case 17:
          push = true;
          if(debug) {
            debugString += 'SLICE_BLA_W_RADL ';
          }
          break;
        case 18:
          push = true;
          if(debug) {
            debugString += 'SLICE_BLA_N_LP ';
          }
          break;
        case 19:
          push = true;
          if(debug) {
            debugString += 'SLICE_IDR_W_RADL ';
          }
          key = true;
          break;
        case 20:
          push = true;
          if(debug) {
            debugString += 'SLICE_IDR_N_LP ';
          }
          key = true;
          break;
        case 21:
          push = true;
          if(debug) {
            debugString += 'SLICE_CRA_NUT ';
          }
          key = true;
          break;
        case 32:
          push = true;
          unit.data = this.discardEPB(unit.data);
          track.vps = [unit.data];
          if(debug) {
            debugString += 'VPS ';
          }
          break;
        //SPS
        case 33:
          push = true;
          if(debug) {
            debugString += 'SPS ';
          }
          unit.data = this.discardEPB(unit.data);
          track.sps = [unit.data];

          var hevcSPSParser = new HEVCSpsParser(unit.data);
          var config = hevcSPSParser.readSPSHEVC();
          track.width = config.width;
          track.height = config.height;
          track.general_profile_space = config.general_profile_space;
          track.general_tier_flag = config.general_tier_flag;
          track.general_profile_idc = config.general_profile_idc;
          track.general_level_idc = config.general_level_idc
          track.duration = this._duration;
          track.codec = 'hev1.1.6.L93.B0';
          track.chromaFormatIdc = config.chromaFormatIdc;
          track.bitDepthLumaMinus8 = config.bitDepthLumaMinus8;
          track.bitDepthChromaMinus8 = config.bitDepthChromaMinus8;
          // console.log('hevc sps: ')
          // console.log(config)
          break;
        //PPS
        case 34:
          push = true;
          if(debug) {
            debugString += 'PPS ';
          }
          // if (!track.pps) {
            track.pps = [unit.data];
          // }
          break;
        case 35:
          push = false;
          if(debug) {
            debugString += 'AUD ';
          }
          pushAccesUnit();
          break;
        case 36:
          push = true;
          if(debug) {
            debugString += 'EOS ';
          }
          break;
        case 37:
          push = true;
          if(debug) {
            debugString += 'EOB ';
          }
          break;
        case 38:
          push = true;
          if(debug) {
            debugString += 'FD ';
          }
          break;
        case 39:
          push = true;
          if(debug) {
            debugString += 'PREFIX_SEI ';
          }
          break;
        case 40:
          push = true;
          if(debug) {
            debugString += 'SUFFIX_SEI ';
          }
          break;
        default:
          push = false;
          debugString += 'unknown NAL ' + unit.type + ' ';
          break;
      }
      if(push) {
        units2.push(unit);
        length+=unit.data.byteLength;
      }
    });
    if(debug || debugString.length) {
      logger.log(debugString);
    }
    pushAccesUnit();
  }

  _parseAVCPES(pes) {
    var track = this._videoTrack,
        samples = track.samples,
        units = this._parseAVCNALu(pes.data),
        units2 = [],
        debug = false,
        key = false,
        length = 0,
        expGolombDecoder,
        avcSample,
        push,
        i;
    // no NALu found
    if (units.length === 0 && samples.length > 0) {
      // append pes.data to previous NAL unit
      var lastavcSample = samples[samples.length - 1];
      var lastUnit = lastavcSample.units.units[lastavcSample.units.units.length - 1];
      var tmp = new Uint8Array(lastUnit.data.byteLength + pes.data.byteLength);
      tmp.set(lastUnit.data, 0);
      tmp.set(pes.data, lastUnit.data.byteLength);
      lastUnit.data = tmp;
      lastavcSample.units.length += pes.data.byteLength;
      track.len += pes.data.byteLength;
    }
    //free pes.data to save up some memory
    pes.data = null;
    var debugString = '';

    var pushAccesUnit = function() {
      if (units2.length) {
        // only push AVC sample if starting with a keyframe is not mandatory OR
        //    if keyframe already found in this fragment OR
        //       keyframe found in last fragment (track.sps) AND
        //          samples already appended (we already found a keyframe in this fragment) OR fragment is contiguous
        if (!this.config.forceKeyFrameOnDiscontinuity ||
            key === true ||
            (track.sps && (samples.length || this.contiguous))) {
          avcSample = {units: { units : units2, length : length}, pts: pes.pts, dts: pes.dts, key: key};
          samples.push(avcSample);
          track.len += length;
          track.nbNalu += units2.length;
        } else {
          // dropped samples, track it
          track.dropped++;
        }
        units2 = [];
        length = 0;
      }
    }.bind(this);

    units.forEach(unit => {
      switch(unit.type) {
        //NDR
         case 1:
           push = true;
           if(debug) {
            debugString += 'NDR ';
           }
           break;
        //IDR
        case 5:
          push = true;
          if(debug) {
            debugString += 'IDR ';
          }
          key = true;
          break;
        //SEI
        case 6:
          push = true;
          if(debug) {
            debugString += 'SEI ';
          }
          unit.data = this.discardEPB(unit.data);
          expGolombDecoder = new ExpGolomb(unit.data);

          // skip frameType
          expGolombDecoder.readUByte();

          var payloadType = 0;
          var payloadSize = 0;
          var endOfCaptions = false;
          var b = 0;

          while (!endOfCaptions && expGolombDecoder.bytesAvailable > 1) {
            payloadType = 0;
            do {
                b = expGolombDecoder.readUByte();
                payloadType += b;
            } while (b === 0xFF);

            // Parse payload size.
            payloadSize = 0;
            do {
                b = expGolombDecoder.readUByte();
                payloadSize += b;
            } while (b === 0xFF);

            // TODO: there can be more than one payload in an SEI packet...
            // TODO: need to read type and size in a while loop to get them all
            if (payloadType === 4 && expGolombDecoder.bytesAvailable !== 0) {

              endOfCaptions = true;

              var countryCode = expGolombDecoder.readUByte();

              if (countryCode === 181) {
                var providerCode = expGolombDecoder.readUShort();

                if (providerCode === 49) {
                  var userStructure = expGolombDecoder.readUInt();

                  if (userStructure === 0x47413934) {
                    var userDataType = expGolombDecoder.readUByte();

                    // Raw CEA-608 bytes wrapped in CEA-708 packet
                    if (userDataType === 3) {
                      var firstByte = expGolombDecoder.readUByte();
                      var secondByte = expGolombDecoder.readUByte();

                      var totalCCs = 31 & firstByte;
                      var byteArray = [firstByte, secondByte];

                      for (i = 0; i < totalCCs; i++) {
                        // 3 bytes per CC
                        byteArray.push(expGolombDecoder.readUByte());
                        byteArray.push(expGolombDecoder.readUByte());
                        byteArray.push(expGolombDecoder.readUByte());
                      }

                      this._insertSampleInOrder(this._txtTrack.samples, { type: 3, pts: pes.pts, bytes: byteArray });
                    }
                  }
                }
              }
            }
            else if (payloadSize < expGolombDecoder.bytesAvailable)
            {
              for (i = 0; i<payloadSize; i++)
              {
                expGolombDecoder.readUByte();
              }
            }
          }
          break;
        //SPS
        case 7:
          push = true;
          if(debug) {
            debugString += 'SPS ';
          }
          if(!track.sps) {
            expGolombDecoder = new ExpGolomb(unit.data);
            var config = expGolombDecoder.readSPS();
            track.width = config.width;
            track.height = config.height;
            track.sps = [unit.data];
            track.duration = this._duration;
            var codecarray = unit.data.subarray(1, 4);
            var codecstring = 'avc1.';
            for (i = 0; i < 3; i++) {
              var h = codecarray[i].toString(16);
              if (h.length < 2) {
                h = '0' + h;
              }
              codecstring += h;
            }
            track.codec = codecstring;
          }
          break;
        //PPS
        case 8:
          push = true;
          if(debug) {
            debugString += 'PPS ';
          }
          if (!track.pps) {
            track.pps = [unit.data];
          }
          break;
        case 9:
          push = false;
          if(debug) {
            debugString += 'AUD ';
          }
          pushAccesUnit();
          break;
        default:
          push = false;
          debugString += 'unknown NAL ' + unit.type + ' ';
          break;
      }
      if(push) {
        units2.push(unit);
        length+=unit.data.byteLength;
      }
    });
    if(debug || debugString.length) {
      logger.log(debugString);
    }
    pushAccesUnit();
  }

  _insertSampleInOrder(arr, data) {
    var len = arr.length;
    if (len > 0) {
      if (data.pts >= arr[len-1].pts)
      {
        arr.push(data);
      }
      else {
        for (var pos = len - 1; pos >= 0; pos--) {
          if (data.pts < arr[pos].pts) {
            arr.splice(pos, 0, data);
            break;
          }
        }
      }
    }
    else {
      arr.push(data);
    }
  }

  _parseHEVCNALu(array) {
    var i = 0, len = array.byteLength, value, overflow, state = this.avcNaluState;
    var units = [], unit, unitType, lastUnitStart, lastUnitType;
    //logger.log('PES:' + Hex.hexDump(array));
    while (i < len) {
      value = array[i++];
      // finding 3 or 4-byte start codes (00 00 01 OR 00 00 00 01)
      switch (state) {
        case 0:
          if (value === 0) {
            state = 1;
          }
          break;
        case 1:
          if( value === 0) {
            state = 2;
          } else {
            state = 0;
          }
          break;
        case 2:
        case 3:
          if( value === 0) {
            state = 3;
          } else if (value === 1 && i < len) {
            unitType = (array[i] >>> 1) & 0x3F;
            // logger.log('find NALU @ offset:' + i + ',type:' + unitType);
            if (lastUnitStart) {
              unit = {data: array.subarray(lastUnitStart, i - state - 1), type: lastUnitType};
              //logger.log('pushing NALU, type/size:' + unit.type + '/' + unit.data.byteLength);
              units.push(unit);
            } else {
              // lastUnitStart is undefined => this is the first start code found in this PES packet
              // first check if start code delimiter is overlapping between 2 PES packets,
              // ie it started in last packet (lastState not zero)
              // and ended at the beginning of this PES packet (i <= 4 - lastState)
              let lastState = this.avcNaluState;
              if(lastState &&  (i <= 4 - lastState)) {
                // start delimiter overlapping between PES packets
                // strip start delimiter bytes from the end of last NAL unit
                // console.log('this._videoTrack: ', this._videoTrack)
                let track = this._videoTrack,
                    samples = track.samples;
                if (samples.length) {
                  let lastavcSample = samples[samples.length - 1],
                      lastUnits = lastavcSample.units.units,
                      lastUnit = lastUnits[lastUnits.length - 1];
                  // check if lastUnit had a state different from zero
                  if (lastUnit.state) {
                    // strip last bytes
                    lastUnit.data = lastUnit.data.subarray(0,lastUnit.data.byteLength - lastState);
                    lastavcSample.units.length -= lastState;
                    track.len -= lastState;
                  }
                }
              }
              // If NAL units are not starting right at the beginning of the PES packet, push preceding data into previous NAL unit.
              overflow  = i - state - 1;
              if (overflow > 0) {
                // console.log('this._avcTrack: ', this._avcTrack)
                let track = this._videoTrack,
                    samples = track.samples;
                //logger.log('first NALU found with overflow:' + overflow);
                if (samples.length) {
                  let lastavcSample = samples[samples.length - 1],
                      lastUnits = lastavcSample.units.units,
                      lastUnit = lastUnits[lastUnits.length - 1],
                      tmp = new Uint8Array(lastUnit.data.byteLength + overflow);
                  tmp.set(lastUnit.data, 0);
                  tmp.set(array.subarray(0, overflow), lastUnit.data.byteLength);
                  lastUnit.data = tmp;
                  lastavcSample.units.length += overflow;
                  track.len += overflow;
                }
              }
            }
            lastUnitStart = i;
            lastUnitType = unitType;
            state = 0;
          } else {
            state = 0;
          }
          break;
        default:
          break;
      }
    }
    if (lastUnitStart) {
      unit = {data: array.subarray(lastUnitStart, len), type: lastUnitType, state : state};
      units.push(unit);
      //logger.log('pushing NALU, type/size/state:' + unit.type + '/' + unit.data.byteLength + '/' + state);
      this.avcNaluState = state;
    }
    return units;
  }

  _parseAVCNALu(array) {
    var i = 0, len = array.byteLength, value, overflow, state = this.avcNaluState;
    var units = [], unit, unitType, lastUnitStart, lastUnitType;
    //logger.log('PES:' + Hex.hexDump(array));
    while (i < len) {
      value = array[i++];
      // finding 3 or 4-byte start codes (00 00 01 OR 00 00 00 01)
      switch (state) {
        case 0:
          if (value === 0) {
            state = 1;
          }
          break;
        case 1:
          if( value === 0) {
            state = 2;
          } else {
            state = 0;
          }
          break;
        case 2:
        case 3:
          if( value === 0) {
            state = 3;
          } else if (value === 1 && i < len) {
            unitType = array[i] & 0x1f;
            // logger.log('find NALU @ offset:' + i + ',type:' + unitType);
            if (lastUnitStart) {
              unit = {data: array.subarray(lastUnitStart, i - state - 1), type: lastUnitType};
              //logger.log('pushing NALU, type/size:' + unit.type + '/' + unit.data.byteLength);
              units.push(unit);
            } else {
              // lastUnitStart is undefined => this is the first start code found in this PES packet
              // first check if start code delimiter is overlapping between 2 PES packets,
              // ie it started in last packet (lastState not zero)
              // and ended at the beginning of this PES packet (i <= 4 - lastState)
              let lastState = this.avcNaluState;
              if(lastState &&  (i <= 4 - lastState)) {
                // start delimiter overlapping between PES packets
                // strip start delimiter bytes from the end of last NAL unit
                let track = this._avcTrack,
                    samples = track.samples;
                if (samples.length) {
                  let lastavcSample = samples[samples.length - 1],
                      lastUnits = lastavcSample.units.units,
                      lastUnit = lastUnits[lastUnits.length - 1];
                  // check if lastUnit had a state different from zero
                  if (lastUnit.state) {
                    // strip last bytes
                    lastUnit.data = lastUnit.data.subarray(0,lastUnit.data.byteLength - lastState);
                    lastavcSample.units.length -= lastState;
                    track.len -= lastState;
                  }
                }
              }
              // If NAL units are not starting right at the beginning of the PES packet, push preceding data into previous NAL unit.
              overflow  = i - state - 1;
              if (overflow > 0) {
                let track = this._avcTrack,
                    samples = track.samples;
                //logger.log('first NALU found with overflow:' + overflow);
                if (samples.length) {
                  let lastavcSample = samples[samples.length - 1],
                      lastUnits = lastavcSample.units.units,
                      lastUnit = lastUnits[lastUnits.length - 1],
                      tmp = new Uint8Array(lastUnit.data.byteLength + overflow);
                  tmp.set(lastUnit.data, 0);
                  tmp.set(array.subarray(0, overflow), lastUnit.data.byteLength);
                  lastUnit.data = tmp;
                  lastavcSample.units.length += overflow;
                  track.len += overflow;
                }
              }
            }
            lastUnitStart = i;
            lastUnitType = unitType;
            state = 0;
          } else {
            state = 0;
          }
          break;
        default:
          break;
      }
    }
    if (lastUnitStart) {
      unit = {data: array.subarray(lastUnitStart, len), type: lastUnitType, state : state};
      units.push(unit);
      //logger.log('pushing NALU, type/size/state:' + unit.type + '/' + unit.data.byteLength + '/' + state);
      this.avcNaluState = state;
    }
    return units;
  }

  /**
   * remove Emulation Prevention bytes from a RBSP
   */
  discardEPB(data) {
    var length = data.byteLength,
        EPBPositions = [],
        i = 1,
        newLength, newData;

    // Find all `Emulation Prevention Bytes`
    while (i < length - 2) {
      if (data[i] === 0 &&
          data[i + 1] === 0 &&
          data[i + 2] === 0x03) {
        EPBPositions.push(i + 2);
        i += 2;
      } else {
        i++;
      }
    }

    // If no Emulation Prevention Bytes were found just return the original
    // array
    if (EPBPositions.length === 0) {
      return data;
    }

    // Create a new array to hold the NAL unit data
    newLength = length - EPBPositions.length;
    newData = new Uint8Array(newLength);
    var sourceIndex = 0;

    for (i = 0; i < newLength; sourceIndex++, i++) {
      if (sourceIndex === EPBPositions[0]) {
        // Skip this byte
        sourceIndex++;
        // Remove this position index
        EPBPositions.shift();
      }
      newData[i] = data[sourceIndex];
    }
    return newData;
  }

  _parseAACPES(pes) {
    var track = this._aacTrack,
        data = pes.data,
        pts = pes.pts,
        startOffset = 0,
        duration = this._duration,
        audioCodec = this.audioCodec,
        aacOverFlow = this.aacOverFlow,
        aacLastPTS = this.aacLastPTS,
        config, frameLength, frameDuration, frameIndex, offset, headerLength, stamp, len, aacSample;
    if (aacOverFlow) {
      var tmp = new Uint8Array(aacOverFlow.byteLength + data.byteLength);
      tmp.set(aacOverFlow, 0);
      tmp.set(data, aacOverFlow.byteLength);
      //logger.log(`AAC: append overflowing ${aacOverFlow.byteLength} bytes to beginning of new PES`);
      data = tmp;
    }
    // look for ADTS header (0xFFFx)
    for (offset = startOffset, len = data.length; offset < len - 1; offset++) {
      if ((data[offset] === 0xff) && (data[offset+1] & 0xf0) === 0xf0) {
        break;
      }
    }
    // if ADTS header does not start straight from the beginning of the PES payload, raise an error
    if (offset) {
      var reason, fatal;
      if (offset < len - 1) {
        reason = `AAC PES did not start with ADTS header,offset:${offset}`;
        fatal = false;
      } else {
        reason = 'no ADTS header found in AAC PES';
        fatal = true;
      }
      this.observer.trigger(Event.ERROR, {type: ErrorTypes.MEDIA_ERROR, id : this.id, details: ErrorDetails.FRAG_PARSING_ERROR, fatal: fatal, reason: reason});
      if (fatal) {
        return;
      }
    }
    if (!track.audiosamplerate) {
      config = ADTS.getAudioConfig(this.observer,data, offset, audioCodec);
      track.config = config.config;
      track.audiosamplerate = config.samplerate;
      track.channelCount = config.channelCount;
      track.codec = config.codec;
      track.duration = duration;
      logger.log(`parsed codec:${track.codec},rate:${config.samplerate},nb channel:${config.channelCount}`);
    }
    frameIndex = 0;
    frameDuration = 1024 * 90000 / track.audiosamplerate;

    // if last AAC frame is overflowing, we should ensure timestamps are contiguous:
    // first sample PTS should be equal to last sample PTS + frameDuration
    if(aacOverFlow && aacLastPTS) {
      var newPTS = aacLastPTS+frameDuration;
      if(Math.abs(newPTS-pts) > 1) {
        logger.log(`AAC: align PTS for overlapping frames by ${Math.round((newPTS-pts)/90)}`);
        pts=newPTS;
      }
    }

    while ((offset + 5) < len) {
      // The protection skip bit tells us if we have 2 bytes of CRC data at the end of the ADTS header
      headerLength = (!!(data[offset + 1] & 0x01) ? 7 : 9);
      // retrieve frame size
      frameLength = ((data[offset + 3] & 0x03) << 11) |
                     (data[offset + 4] << 3) |
                    ((data[offset + 5] & 0xE0) >>> 5);
      frameLength  -= headerLength;
      //stamp = pes.pts;

      if ((frameLength > 0) && ((offset + headerLength + frameLength) <= len)) {
        stamp = pts + frameIndex * frameDuration;
        //logger.log(`AAC frame, offset/length/total/pts:${offset+headerLength}/${frameLength}/${data.byteLength}/${(stamp/90).toFixed(0)}`);
        aacSample = {unit: data.subarray(offset + headerLength, offset + headerLength + frameLength), pts: stamp, dts: stamp};
        track.samples.push(aacSample);
        track.len += frameLength;
        offset += frameLength + headerLength;
        frameIndex++;
        // look for ADTS header (0xFFFx)
        for ( ; offset < (len - 1); offset++) {
          if ((data[offset] === 0xff) && ((data[offset + 1] & 0xf0) === 0xf0)) {
            break;
          }
        }
      } else {
        break;
      }
    }
    if (offset < len) {
      aacOverFlow = data.subarray(offset, len);
      //logger.log(`AAC: overflow detected:${len-offset}`);
    } else {
      aacOverFlow = null;
    }
    this.aacOverFlow = aacOverFlow;
    this.aacLastPTS = stamp;
  }

  _parseID3PES(pes) {
    this._id3Track.samples.push(pes);
  }
}

export default TSDemuxer;
