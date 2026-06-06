import Image from "next/image";

interface BeaverMascotProps {
  /** Filename without extension, e.g. "01_waving" */
  pose: string;
  /** Width and height in pixels */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

export default function BeaverMascot({
  pose,
  size = 200,
  className = "",
}: BeaverMascotProps) {
  return (
    <Image
      src={`/mascot/${pose}.png`}
      alt={`Bosphor beaver ${pose.replace(/^\d+_/, "")}`}
      width={size}
      height={size}
      className={`brightness-0 invert ${className}`}
      priority
    />
  );
}
