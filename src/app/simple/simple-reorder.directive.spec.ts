import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleReorderDirective, SimpleCardMove } from './simple-reorder.directive';

@Component({
  imports: [SimpleReorderDirective],
  template: ` <div [attr.data-order-group]="group()">
      <div data-order-key="A">
        <button appSimpleReorder="A" (reordered)="moves.push($event)">A</button>
      </div>
      <div data-order-key="B">
        <button appSimpleReorder="B" (reordered)="moves.push($event)">B</button>
      </div>
    </div>
    <div data-order-group="foreign"><div data-order-key="C">C</div></div>`,
})
class Host {
  group = signal('Local/tasks');
  moves: SimpleCardMove[] = [];
}

describe('pointer card reorder handle', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<Host>>;
  let handle: HTMLButtonElement;
  const hit = vi.fn();
  function pointer(target: EventTarget, type: string, x: number, y: number, id = 1): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, isPrimary: true, pointerId: id, clientX: x, clientY: y });
    target.dispatchEvent(event);
  }
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    handle = fixture.nativeElement.querySelector('button');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
    hit.mockReturnValue(fixture.nativeElement.querySelector('[data-order-key=B]'));
  });
  afterEach(() => {
    fixture.destroy();
    hit.mockReset();
    delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
  });
  it('preserves ordinary clicks, waits for threshold and commits only a same-group target', () => {
    pointer(handle, 'pointerdown', 10, 10);
    pointer(document, 'pointermove', 13, 13);
    pointer(document, 'pointerup', 13, 13);
    expect(fixture.componentInstance.moves).toEqual([]);
    expect(document.querySelector('.simple-order-ghost')).toBeNull();
    pointer(handle, 'pointerdown', 10, 10);
    pointer(document, 'pointermove', 30, 30);
    expect(document.querySelector('.simple-order-ghost')?.getAttribute('aria-hidden')).toBe('true');
    pointer(document, 'pointerup', 30, 30);
    expect(fixture.componentInstance.moves).toEqual([{ from: 'A', to: 'B' }]);
    expect(document.querySelector('.simple-order-ghost')).toBeNull();
  });
  it('rejects other pointers, other groups and drops outside a card', () => {
    pointer(handle, 'pointerdown', 10, 10);
    pointer(document, 'pointermove', 30, 30, 2);
    expect(document.querySelector('.simple-order-ghost')).toBeNull();
    hit.mockReturnValue(fixture.nativeElement.querySelector('[data-order-key=C]'));
    pointer(document, 'pointermove', 30, 30);
    pointer(document, 'pointerup', 30, 30);
    expect(fixture.componentInstance.moves).toEqual([]);
    hit.mockReturnValue(null);
    pointer(handle, 'pointerdown', 10, 10);
    pointer(document, 'pointermove', 30, 30);
    pointer(document, 'pointerup', 30, 30);
    expect(fixture.componentInstance.moves).toEqual([]);
  });
  it('cancels on Escape, pointer cancellation, scope change, blur and destruction', () => {
    for (const reason of ['escape', 'cancel', 'scope', 'blur', 'resize', 'destroy']) {
      pointer(handle, 'pointerdown', 10, 10);
      pointer(document, 'pointermove', 30, 30);
      if (reason === 'escape')
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (reason === 'cancel') pointer(document, 'pointercancel', 30, 30);
      if (reason === 'scope') {
        fixture.componentInstance.group.set('Other/tasks');
        fixture.detectChanges();
      }
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      if (reason === 'resize') window.dispatchEvent(new Event('resize'));
      if (reason === 'destroy') fixture.destroy();
      pointer(document, 'pointerup', 30, 30);
      expect(fixture.componentInstance.moves).toEqual([]);
      expect(document.querySelector('.simple-order-ghost')).toBeNull();
      expect(document.querySelector('[data-order-source]')).toBeNull();
      expect(document.documentElement.hasAttribute('data-simple-order-dragging')).toBe(false);
    }
  });
  it('supports arrows on the handle without wrapping beyond the first or last card', () => {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(fixture.componentInstance.moves).toEqual([]);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(fixture.componentInstance.moves).toEqual([{ from: 'A', to: 'B' }]);
  });
  it('preserves the full card dimensions and anchors the preview at a far-right grab point', () => {
    const source = handle.closest<HTMLElement>('[data-order-key]');
    if (!source) throw new Error('Missing source');
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 100,
      width: 800,
      height: 78,
      right: 1000,
      bottom: 178,
      x: 200,
      y: 100,
      toJSON: (): object => ({}),
    });
    pointer(handle, 'pointerdown', 980, 139);
    pointer(document, 'pointermove', 980, 239);
    const ghost = document.querySelector<HTMLElement>('.simple-order-ghost');
    expect(ghost?.style.position).toBe('fixed');
    expect(ghost?.style.width).toBe('800px');
    expect(ghost?.style.height).toBe('78px');
    expect(ghost?.style.transform).toBe('translate(200px, 200px)');
    expect(ghost?.inert).toBe(true);
    expect(source.getAttribute('data-order-source')).toBe('true');
    expect(document.documentElement.getAttribute('data-simple-order-dragging')).toBe('true');
    pointer(document, 'pointermove', 0, 0);
    expect(ghost?.style.transform).toBe('translate(0px, 0px)');
    pointer(document, 'pointermove', 10000, 10000);
    expect(ghost?.style.transform).toBe(
      `translate(${window.innerWidth - 800}px, ${window.innerHeight - 78}px)`
    );
    pointer(document, 'pointercancel', 10000, 10000);
    expect(source.hasAttribute('data-order-source')).toBe(false);
    expect(document.documentElement.hasAttribute('data-simple-order-dragging')).toBe(false);
  });
});
