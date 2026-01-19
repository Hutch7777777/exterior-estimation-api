let counter = 0;

export const v4 = (): string => {
  counter++;
  return `test-uuid-${counter}`;
};

export default { v4 };
