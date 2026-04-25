import { useMemo, useState } from 'react';
import {
  buildWireframeAnswerPrompt,
  type WireframeQuestion
} from '@renderer/lib/wireframe';

interface WireframeQuestionFormProps {
  questions: WireframeQuestion[];
  disabled?: boolean;
  onSubmit: (prompt: string) => Promise<void>;
}

export function WireframeQuestionForm(props: WireframeQuestionFormProps) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const controlsDisabled = props.disabled || submitting || submitted;
  const readyToSubmit = useMemo(
    () =>
      props.questions.every((question) => (answers[question.id] ?? []).length > 0),
    [answers, props.questions]
  );

  function toggleAnswer(question: WireframeQuestion, optionId: string) {
    if (controlsDisabled) {
      return;
    }

    setAnswers((current) => {
      if (question.selection === 'single') {
        return {
          ...current,
          [question.id]: [optionId]
        };
      }

      const selected = new Set(current[question.id] ?? []);

      if (selected.has(optionId)) {
        selected.delete(optionId);
      } else {
        selected.add(optionId);
      }

      return {
        ...current,
        [question.id]: [...selected]
      };
    });
  }

  async function handleSubmit() {
    if (!readyToSubmit || controlsDisabled) {
      return;
    }

    setSubmitting(true);
    try {
      await props.onSubmit(
        buildWireframeAnswerPrompt({
          questions: props.questions,
          answers
        })
      );
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="motion-panel rounded-lg border border-cyan-300/20 bg-cyan-400/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-200/80">
            Wireframe Questions
          </p>
          <p className="mt-1 text-sm text-slate-300">
            Select the answers that best match the product direction.
          </p>
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300">
          {props.questions.length} item{props.questions.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="mt-4 space-y-4">
        {props.questions.map((question, questionIndex) => (
          <fieldset
            className="rounded-lg border border-white/10 bg-slate-950/45 p-3"
            key={question.id}
          >
            <legend className="px-1 text-sm font-medium text-slate-100">
              {questionIndex + 1}. {question.label}
            </legend>
            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-slate-500">
              {question.selection === 'multi' ? 'Multi select' : 'Single select'}
            </p>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {question.options.map((option) => {
                const selected = (answers[question.id] ?? []).includes(option.id);
                const inputType = question.selection === 'multi' ? 'checkbox' : 'radio';

                return (
                  <label
                    className={`motion-interactive flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 text-sm transition ${
                      selected
                        ? 'border-cyan-300/40 bg-cyan-400/10 text-cyan-50'
                        : 'border-white/10 bg-white/[0.03] text-slate-200 hover:bg-white/5'
                    }`}
                    key={option.id}
                  >
                    <input
                      checked={selected}
                      className="mt-1 h-4 w-4 accent-cyan-400"
                      disabled={controlsDisabled}
                      name={question.id}
                      onChange={() => toggleAnswer(question, option.id)}
                      type={inputType}
                    />
                    <span>
                      <span className="font-medium">{option.id}.</span> {option.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="mt-4 flex justify-end">
        {submitted ? (
          <p
            aria-live="polite"
            className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-2.5 text-sm font-semibold text-emerald-100"
          >
            Answers submitted
          </p>
        ) : (
          <button
            className="motion-interactive rounded-2xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
            disabled={!readyToSubmit || props.disabled || submitting}
            onClick={() => {
              void handleSubmit();
            }}
            type="button"
          >
            {submitting ? 'Submitting...' : 'Submit answers'}
          </button>
        )}
      </div>
    </section>
  );
}
