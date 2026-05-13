import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmail, sendSprintAlert } from '../email.js';

const sendMock = vi.fn();

vi.mock('resend', () => ({
  Resend: function Resend() {
    return { emails: { send: sendMock } };
  },
}));

describe('sendEmail', () => {
  const originalKey = process.env['RESEND_API_KEY'];

  beforeEach(() => {
    process.env['RESEND_API_KEY'] = 're_test_key';
    sendMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env['RESEND_API_KEY'];
    } else {
      process.env['RESEND_API_KEY'] = originalKey;
    }
  });

  it('throws when RESEND_API_KEY is missing', async () => {
    delete process.env['RESEND_API_KEY'];
    await expect(
      sendEmail({ to: 'test@example.com', subject: 'Hi', html: '<p>Hi</p>' }),
    ).rejects.toThrow('RESEND_API_KEY is not set');
  });

  it('returns message id on success', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_abc123' }, error: null });

    const result = await sendEmail({ to: 'test@example.com', subject: 'Hello', html: '<p>Hello</p>' });

    expect(result.id).toBe('msg_abc123');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['test@example.com'], subject: 'Hello' }),
    );
  });

  it('uses default from address when not specified', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_xyz' }, error: null });

    await sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>S</p>' });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'IFleet <onboarding@resend.dev>' }),
    );
  });

  it('respects custom from address', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_custom' }, error: null });

    await sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>S</p>', from: 'Me <me@mine.com>' });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Me <me@mine.com>' }),
    );
  });

  it('throws on API error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid_api_key', name: 'validation_error' } });

    await expect(
      sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>S</p>' }),
    ).rejects.toThrow('Resend API error: invalid_api_key');
  });

  it('accepts array of recipients', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_multi' }, error: null });

    await sendEmail({ to: ['a@b.com', 'c@d.com'], subject: 'S', html: '<p>S</p>' });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['a@b.com', 'c@d.com'] }),
    );
  });
});

describe('sendSprintAlert', () => {
  beforeEach(() => {
    process.env['RESEND_API_KEY'] = 're_test_key';
    sendMock.mockReset();
  });

  it('prefixes subject with [IFleet] and embeds sprint id in html', async () => {
    sendMock.mockResolvedValue({ data: { id: 'msg_alert' }, error: null });

    await sendSprintAlert({
      to: 'seb@example.com',
      sprintId: 'sprint_001',
      subject: 'Budget exceeded',
      body: 'Cost threshold hit at $50',
    });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[IFleet] Budget exceeded',
        html: expect.stringContaining('sprint_001'),
      }),
    );
  });
});
