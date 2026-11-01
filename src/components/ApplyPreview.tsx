import { useState } from 'react'
import type { ApplyPlan, Baseline } from '../contracts'

type Props = {
  plan: ApplyPlan
  source: Baseline | null
  busy: boolean
  temporary: boolean
  onMode: (mode: ApplyPlan['mode']) => void
  onBack: () => void
  onApply: () => void
}

export function ApplyPreview({ plan, source, busy, temporary, onMode, onBack, onApply }: Props) {
  const [showContents, setShowContents] = useState(false)
  const copy = plan.mode === 'create-clean-copy'
  const removedByChoice = source?.orderedEntries.filter((entry) => entry.sourceUri && plan.removeUris.includes(entry.sourceUri)).length ?? 0
  const duplicates = Math.max(0, plan.removedOccurrences - removedByChoice)
  return <section className="preview-panel" aria-label="Предпросмотр изменений">
    <fieldset className="apply-mode" disabled={busy}>
      <legend>Как сохранить результат?</legend>
      <label><input type="radio" name="apply-mode" checked={!copy} onChange={() => onMode('remove-uri-groups')} />Убрать из исходника</label>
      <label><input type="radio" name="apply-mode" checked={copy} disabled={temporary} onChange={() => onMode('create-clean-copy')} />Создать копию без дублей</label>
    </fieldset>
    {temporary && <p className="field-hint">Для создания копии нужно доступное локальное хранилище. Разреши его и обнови страницу.</p>}
    <div className="preview-heading">
      <h2>{copy ? `Создать копию из ${plan.expectedOrderedEntries.length} записей?` : `Удалить ${plan.removedOccurrences} вхождения?`}</h2>
      <p>{copy ? `${removedByChoice} вхождений по решениям · ${duplicates} точных дублей исключено` : `${plan.removeUris.length} уникальных треков · останется ${plan.expectedOrderedEntries.length} записей`}</p>
    </div>
    {copy && <p className="description">Исходный плейлист сохранится целиком. В новой приватной копии останется первое вхождение каждого трека в исходном порядке. Непросмотренные треки тоже сохранятся.</p>}
    {plan.blockedReasons.length > 0 && <p className="feedback error" role="alert">{plan.blockedReasons.join(' ')}</p>}
    {copy ? <details className="copy-contents" onToggle={(event) => setShowContents(event.currentTarget.open)}><summary>Состав копии · {plan.expectedOrderedEntries.length} записей</summary>{showContents && <ol>{plan.expectedOrderedEntries.map((entry) => <li key={entry.entryKey}><strong>{entry.title}</strong><span>{entry.artist}</span></li>)}</ol>}</details> : plan.removeUris.length ? <ul className="preview-list">{plan.removeUris.map((uri) => {
      const group = source?.orderedEntries.filter((entry) => entry.sourceUri === uri) ?? []
      return <li key={uri}><span><strong>{group[0]?.title ?? 'Трек'}</strong><span>{group[0]?.artist}</span></span><span>{group.length} вхождения</span></li>
    })}</ul> : <p className="description">Ни один трек не помечен на удаление. Плейлист сохранится целиком.</p>}
    <p className="field-hint">Это демо: изменения сохраняются только на этом устройстве и не затрагивают Spotify.</p>
    <div className="button-row"><button className="button secondary" disabled={busy} onClick={onBack}>Вернуться к решениям</button><button className="button primary" disabled={busy || Boolean(plan.blockedReasons.length)} onClick={onApply}>{busy ? 'Проверяем результат…' : copy ? 'Создать копию в демо' : 'Применить в демо'}</button></div>
  </section>
}
