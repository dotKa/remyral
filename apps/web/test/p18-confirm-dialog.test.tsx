// p18-confirm-dialog: no confirmation is rendered inline (next to / in place of its trigger, or inside a menu). The
// hand-rolled confirmations use the shared confirm dialog (`DyConfirmDialog`), like `DyConfirm`.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RowMenu } from '../src/diyalog/chat/RowMenu';

describe('p18-confirm-dialog — hand-rolled confirmations are dialogs', () => {
  it('row menu: a destructive item closes the menu and asks in a confirm dialog; Vazgeç / Escape run nothing', async () => {
    const user = userEvent.setup();
    const remove = vi.fn();
    const pin = vi.fn();
    render(
      <RowMenu
        label="Sohbet işlemleri"
        items={[
          { key: 'pin', label: 'Sabitle', onSelect: pin },
          {
            key: 'delete',
            label: 'Sil',
            danger: true,
            confirm: { question: 'Bu sohbet silinsin mi?', yes: 'Kalıcı olarak sil', no: 'Vazgeç' },
            onSelect: remove,
          },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Sohbet işlemleri' });
    await user.click(button);
    await user.click(await screen.findByRole('menuitem', { name: 'Sil' }));
    // The menu is gone; the question is a modal dialog, not a line inside the menu.
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    const ask = await screen.findByRole('dialog', { name: 'Bu sohbet silinsin mi?' });
    expect(remove).not.toHaveBeenCalled();
    // Destructive: focus starts on Vazgeç.
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Vazgeç' }));
    await user.click(within(ask).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(button);
    });

    // Escape (the native dialog's `cancel`) closes it too.
    await user.click(button);
    await user.click(await screen.findByRole('menuitem', { name: 'Sil' }));
    const again = await screen.findByRole('dialog', { name: 'Bu sohbet silinsin mi?' });
    fireEvent(again, new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(remove).not.toHaveBeenCalled();

    await user.click(button);
    await user.click(await screen.findByRole('menuitem', { name: 'Sil' }));
    const third = await screen.findByRole('dialog', { name: 'Bu sohbet silinsin mi?' });
    await user.click(within(third).getByRole('button', { name: 'Kalıcı olarak sil' }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(pin).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('row menu: an item without a confirmation runs at once', async () => {
    const user = userEvent.setup();
    const pin = vi.fn();
    render(<RowMenu label="Sohbet işlemleri" items={[{ key: 'pin', label: 'Sabitle', onSelect: pin }]} />);
    await user.click(screen.getByRole('button', { name: 'Sohbet işlemleri' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sabitle' }));
    expect(pin).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
