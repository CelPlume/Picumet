// 视频播放器（DPlayer 风格自定义控制条：播放/后退/前进/进度/时间/静音/音量）
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function VideoPreview({ src, poster, onError }: { src: string; poster?: string; onError?: () => void }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrent(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onErr = () => onError?.();
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onErr);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onErr);
    };
  }, [onError]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };
  const seek = (dt: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + dt));
  };
  const applyVolume = (nv: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = nv;
    v.muted = nv === 0;
    setVolume(nv);
    setMuted(nv === 0);
  };

  return (
    <div className="group relative max-h-[56vh] max-w-full">
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        autoPlay
        playsInline
        className="max-h-[56vh] max-w-full rounded-md bg-black"
        onClick={toggle}
      />
      {/* 控制条（DPlayer 风格：hover 显示，深色渐变底） */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 flex items-center gap-2 rounded-b-md bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8 transition-opacity',
          playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        )}
      >
        <button onClick={toggle} className="shrink-0 rounded-full p-1 text-white transition-colors hover:bg-white/20" aria-label={playing ? t('common.pause') : t('common.play')}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button onClick={() => seek(-10)} className="shrink-0 rounded p-1 text-white/90 transition-colors hover:bg-white/20" aria-label={t('common.rewind10')}>
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => seek(10)} className="shrink-0 rounded p-1 text-white/90 transition-colors hover:bg-white/20" aria-label={t('common.forward10')}>
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={current}
          onChange={(e) => {
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.target.value);
            setCurrent(Number(e.target.value));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
          aria-label={t('common.playbackProgress')}
        />
        <span className="shrink-0 text-xs tabular-nums text-white/90">
          {fmt(current)} / {fmt(duration)}
        </span>
        <button onClick={() => { const v = videoRef.current; if (v) { v.muted = !v.muted; setMuted(v.muted); } }} className="shrink-0 rounded p-1 text-white/90 transition-colors hover:bg-white/20" aria-label={t('common.mute')}>
          {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => applyVolume(Number(e.target.value))}
          className="h-1 w-16 shrink-0 cursor-pointer accent-white"
          aria-label={t('common.volume')}
        />
      </div>
    </div>
  );
}
