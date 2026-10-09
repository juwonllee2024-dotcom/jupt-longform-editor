import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

export function CaptionLayer({ events }) {
  const frame = useCurrentFrame();
  const event = (events || []).find((candidate) => (
    frame >= candidate.startFrame && frame < candidate.endFrame
  ));
  if (!event) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        padding: '0 120px 120px',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: 1460,
          padding: '16px 28px',
          borderRadius: 18,
          background: 'rgba(4, 8, 18, 0.82)',
          boxShadow: '0 10px 35px rgba(0, 0, 0, 0.34)',
          color: '#fff',
          fontFamily: 'Inter, Pretendard, system-ui, sans-serif',
          fontSize: 58,
          fontWeight: 850,
          lineHeight: 1.22,
          letterSpacing: '-0.035em',
          textAlign: 'center',
          textShadow: '0 3px 8px rgba(0, 0, 0, 0.7)',
        }}
      >
        {event.lines.map((line) => (
          <div key={line}>
            {line.split(event.highlight).map((part, index, parts) => (
              <React.Fragment key={`${part}-${index}`}>
                {part}
                {index < parts.length - 1 ? (
                  <span style={{ color: '#78e7d2' }}>{event.highlight}</span>
                ) : null}
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
}
