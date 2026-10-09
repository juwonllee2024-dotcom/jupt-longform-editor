import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  staticFile,
} from 'remotion';
import { circleAnchor } from './editorial-grammar.mjs';
import { sourceVideoTrimProps } from './media-grammar.mjs';

const cover = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

function mediaSource(asset) {
  if (asset?.src) return asset.src;
  if (asset?.staticPath) return staticFile(asset.staticPath);
  return '';
}

function VideoLayer({
  src,
  startFrom = 0,
  trimBefore,
  trimAfter,
  muted = false,
}) {
  if (!src) {
    return (
      <AbsoluteFill
        style={{
          background: '#0b1020',
          justifyContent: 'center',
          alignItems: 'center',
          color: '#ff9aaa',
          fontSize: 42,
        }}
      >
        Missing approved video asset
      </AbsoluteFill>
    );
  }
  const trimProps = Number.isInteger(trimBefore)
    ? {
      trimBefore,
      ...(Number.isInteger(trimAfter) ? { trimAfter } : {}),
    }
    : { startFrom };
  return (
    <OffthreadVideo
      src={src}
      {...trimProps}
      muted={muted}
      style={cover}
    />
  );
}

function VisualLayer({ asset }) {
  const src = mediaSource(asset);
  if (!src) {
    return (
      <AbsoluteFill style={{ background: '#0b1020' }} />
    );
  }
  if (asset.kind === 'screen' || asset.kind === 'video') {
    return <VideoLayer src={src} muted />;
  }
  return (
    <AbsoluteFill style={{ background: '#0b1020' }}>
      <Img src={src} style={cover} />
    </AbsoluteFill>
  );
}

function DialogueOnly({
  faceSrc,
  sourceStartFrame,
}) {
  if (!faceSrc) return null;
  return (
    <OffthreadVideo
      src={faceSrc}
      startFrom={sourceStartFrame}
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  );
}

function FaceCircle({
  faceSrc,
  sourceStartFrame,
  anchorScores,
}) {
  const anchor = circleAnchor(anchorScores);
  const sideStyle = anchor === 'middle-left'
    ? { left: 44 }
    : { right: 44 };
  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        width: 260,
        height: 260,
        borderRadius: '50%',
        overflow: 'hidden',
        border: '6px solid #fff',
        boxShadow: '0 14px 40px rgba(0, 0, 0, 0.45)',
        background: '#10182a',
        ...sideStyle,
      }}
    >
      <VideoLayer src={faceSrc} startFrom={sourceStartFrame} />
    </div>
  );
}

function TitleCard({ segment }) {
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'center',
        padding: 180,
        background: 'radial-gradient(circle at 20% 0%, #253870, #090e1a 55%)',
        color: '#fff',
        fontFamily: 'Inter, Pretendard, system-ui, sans-serif',
      }}
    >
      <div style={{ color: '#78e7d2', fontSize: 30, fontWeight: 800 }}>
        모두를 위한 AI
      </div>
      <div style={{ marginTop: 22, maxWidth: 1400, fontSize: 76, fontWeight: 900, lineHeight: 1.15 }}>
        {segment.spokenText}
      </div>
    </AbsoluteFill>
  );
}

export function SegmentLayout({
  segment,
  faceSrc,
  primaryAsset,
  anchorScores,
  sourceSrc,
  sourceDurationFrames,
}) {
  const resolvedFaceSrc = typeof faceSrc === 'string'
    ? faceSrc
    : mediaSource(faceSrc);
  const resolvedSourceSrc = typeof sourceSrc === 'string'
    ? sourceSrc
    : mediaSource(sourceSrc);
  const sourceTrimProps = sourceVideoTrimProps(segment, sourceDurationFrames);
  if (segment.layout === 'source-full') {
    return (
      <AbsoluteFill>
        <VideoLayer
          src={resolvedSourceSrc}
          {...sourceTrimProps}
        />
      </AbsoluteFill>
    );
  }
  if (segment.layout === 'source-full-face-circle') {
    return (
      <AbsoluteFill>
        <VideoLayer
          src={resolvedSourceSrc}
          {...sourceTrimProps}
        />
        {resolvedFaceSrc
          ? <FaceCircle
            faceSrc={resolvedFaceSrc}
            sourceStartFrame={segment.facecamStartFrame || 0}
            anchorScores={anchorScores}
          />
          : null}
      </AbsoluteFill>
    );
  }
  if (segment.layout === 'face-full') {
    return (
      <AbsoluteFill>
        <VideoLayer
          src={resolvedFaceSrc}
          startFrom={segment.sourceStartFrame}
        />
      </AbsoluteFill>
    );
  }
  if (segment.layout === 'title-card') {
    return (
      <AbsoluteFill>
        <TitleCard segment={segment} />
        <DialogueOnly
          faceSrc={resolvedFaceSrc}
          sourceStartFrame={segment.sourceStartFrame}
        />
      </AbsoluteFill>
    );
  }
  if (segment.layout === 'visual-full') {
    return (
      <AbsoluteFill>
        <VisualLayer asset={primaryAsset} />
        <DialogueOnly
          faceSrc={resolvedFaceSrc}
          sourceStartFrame={segment.sourceStartFrame}
        />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill>
      <VisualLayer asset={primaryAsset} />
      <FaceCircle
        faceSrc={resolvedFaceSrc}
        sourceStartFrame={segment.sourceStartFrame}
        anchorScores={anchorScores}
      />
    </AbsoluteFill>
  );
}
